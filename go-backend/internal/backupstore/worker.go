package backupstore

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/models"
)

// Run starts the upload workers and the janitor until ctx ends.
func (s *Service) Run(ctx context.Context) {
	for i := 0; i < s.cfg.Workers; i++ {
		go s.workerLoop(ctx)
	}
	t := time.NewTicker(s.cfg.JanitorEvery)
	defer t.Stop()
	s.Janitor(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Janitor(ctx)
		}
	}
}

func (s *Service) workerLoop(ctx context.Context) {
	for {
		worked := s.ProcessOne(ctx)
		if worked {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-time.After(30 * time.Second):
		}
	}
}

// uploadedLast24h sums the ledger (bytes sent to the Drive in the rolling window).
func uploadedLast24h() int64 {
	var n int64
	database.DB.Model(&models.DriveUploadLedger{}).Where("at > ?", time.Now().Add(-24*time.Hour)).
		Select("COALESCE(SUM(bytes), 0)").Scan(&n)
	return n
}

// ProcessOne sends the oldest queued blob to its backend. Returns false when idle.
func (s *Service) ProcessOne(ctx context.Context) bool {
	target := s.target()
	if target == "" {
		return false
	}
	now := time.Now()
	var blobs []models.BackupBlob
	database.DB.Where("status <> ? AND next_try_at <= ?", models.BlobStored, now).
		Order("created_at ASC").Limit(20).Find(&blobs)
	for i := range blobs {
		b := &blobs[i]
		if _, busy := s.claimed.LoadOrStore(b.ID, true); busy {
			continue
		}
		func() {
			defer s.claimed.Delete(b.ID)
			s.store(ctx, b, target)
		}()
		return true
	}
	return false
}

func (s *Service) retryLater(b *models.BackupBlob, err error, after time.Duration, countAttempt bool) {
	upd := map[string]any{"next_try_at": time.Now().Add(after), "last_error": err.Error()}
	if countAttempt {
		upd["attempts"] = b.Attempts + 1
		if b.Attempts+1 >= 5 {
			upd["status"] = models.BlobFailed
		}
	}
	database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Updates(upd)
	s.setError(err)
	log.Printf("[backups] blob %d (%s): %v", b.ID, b.FileName, err)
}

func (s *Service) store(ctx context.Context, b *models.BackupBlob, target string) {
	if !exists(b.StagingPath) {
		s.retryLater(b, errors.New("arquivo de staging sumiu; aguardando novo envio"), 24*time.Hour, true)
		return
	}
	if target == models.BackendLocal {
		dst := filepath.Join(s.cfg.localDir(), b.SHA256[:2], b.SHA256)
		if err := moveFile(b.StagingPath, dst); err != nil {
			s.retryLater(b, err, time.Minute, true)
			return
		}
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Updates(map[string]any{
			"status": models.BlobStored, "backend": models.BackendLocal, "local_path": dst, "staging_path": "",
			"last_error": "", "attempts": 0,
		})
		return
	}

	// Google Drive: daily upload budget first.
	s.stateMu.Lock()
	paused := time.Now().Before(s.pauseUntil)
	s.stateMu.Unlock()
	if paused {
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Update("next_try_at", s.pauseUntil)
		return
	}
	if used := uploadedLast24h(); used+b.Size > s.cfg.DailyUploadBudget {
		var oldest models.DriveUploadLedger
		wait := time.Hour
		if found(database.DB.Where("at > ?", time.Now().Add(-24*time.Hour)).Order("at ASC"), &oldest) {
			wait = time.Until(oldest.At.Add(24*time.Hour)) + time.Minute
		}
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Updates(map[string]any{
			"next_try_at": time.Now().Add(wait), "last_error": "aguardando a cota diária de upload do Google Drive",
		})
		return
	}

	d := s.driveService()
	if d == nil {
		s.retryLater(b, ErrNoBackend, 10*time.Minute, false)
		return
	}
	key := userFolderKey(b.OwnerUserID)
	if b.Shared {
		key = "shared"
	}
	parent, err := s.folder(ctx, d, key)
	if err != nil {
		s.retryLater(b, err, 10*time.Minute, !errors.Is(err, gdrive.ErrNoWriteScope))
		return
	}
	name := b.FileName
	if b.Shared {
		name = b.SHA256 + filepath.Ext(b.FileName)
	}
	obj, err := d.UploadResumable(ctx, b.StagingPath, gdrive.UploadMeta{
		Name: name, Parent: parent,
		AppProperties: map[string]string{"mc_sha256": b.SHA256, "mc_blob": strconv.FormatUint(uint64(b.ID), 10)},
	}, b.SessionURI, func(uri string) {
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Update("session_uri", uri)
	}, nil)
	switch {
	case errors.Is(err, gdrive.ErrUploadLimit):
		s.stateMu.Lock()
		s.pauseUntil = time.Now().Add(time.Hour)
		s.stateMu.Unlock()
		s.retryLater(b, err, time.Hour, false)
		return
	case errors.Is(err, gdrive.ErrStorageFull):
		s.retryLater(b, err, time.Hour, false)
		return
	case err != nil:
		s.retryLater(b, err, backoffFor(b.Attempts), true)
		return
	}
	if obj.MD5 != "" && b.MD5 != "" && obj.MD5 != b.MD5 {
		_ = d.DeleteFile(ctx, obj.ID)
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Update("session_uri", "")
		s.retryLater(b, errors.New("checksum diferente depois do upload; reenviando"), time.Minute, true)
		return
	}
	database.DB.Create(&models.DriveUploadLedger{Bytes: b.Size, At: time.Now()})
	staging := b.StagingPath
	database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Updates(map[string]any{
		"status": models.BlobStored, "backend": models.BackendDrive, "drive_file_id": obj.ID, "drive_folder": parent,
		"staging_path": "", "local_path": "", "session_uri": "", "last_error": "", "attempts": 0,
	})
	os.Remove(staging)
	t := true
	s.stateMu.Lock()
	s.writeOK, s.lastError = &t, ""
	s.stateMu.Unlock()
}

func backoffFor(attempts int) time.Duration {
	d := time.Minute << uint(attempts)
	if d > time.Hour || d <= 0 {
		d = time.Hour
	}
	return d
}

// ---------------------------------------------------------------------------- reading

// Source is where a backup's bytes are read from.
type Source struct {
	LocalPath string         // serve this file (local backend, staging or legacy)
	Drive     *http.Response // or stream this Drive response (caller closes Body)
	Size      int64
}

// Open locates the bytes of a backup; rangeHeader is forwarded to the Drive.
func (s *Service) Open(ctx context.Context, save *models.GameSave, rangeHeader string) (*Source, error) {
	if save.BlobID == 0 {
		if !exists(save.Filename) {
			return nil, ErrNotFound
		}
		return &Source{LocalPath: save.Filename, Size: save.Size}, nil
	}
	var b models.BackupBlob
	if !found(database.DB.Where("id = ?", save.BlobID), &b) {
		return nil, ErrNotFound
	}
	switch {
	case b.Status != models.BlobStored && exists(b.StagingPath):
		return &Source{LocalPath: b.StagingPath, Size: b.Size}, nil
	case b.Backend == models.BackendLocal && exists(b.LocalPath):
		return &Source{LocalPath: b.LocalPath, Size: b.Size}, nil
	case b.Backend == models.BackendDrive && b.DriveFileID != "":
		d := s.driveService()
		if d == nil {
			return nil, ErrNoBackend
		}
		resp, err := d.OpenMedia(ctx, b.DriveFileID, rangeHeader)
		if err != nil {
			return nil, err
		}
		return &Source{Drive: resp, Size: b.Size}, nil
	}
	return nil, ErrNotFound
}
