package backupstore

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"go-backend/database"
	"go-backend/internal/uploads"
	"go-backend/models"

	"gorm.io/gorm"
)

// Meta describes one backup sent by the app or the site.
type Meta struct {
	GameName  string `json:"game_name"`
	Platform  string `json:"platform"`
	Kind      string `json:"kind"` // save | game
	FileName  string `json:"file_name"`
	Hash      string `json:"hash"` // client hash (the app's folder hash, used by /check-version)
	Timestamp int64  `json:"timestamp"`
}

var unsafeName = regexp.MustCompile(`[\x00-\x1f/\\:*?"<>|]+`)

func clean(s string, max int, def string) string {
	s = strings.TrimSpace(unsafeName.ReplaceAllString(s, " "))
	for len(s) > max {
		_, n := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-n]
	}
	if s == "" || s == "." || s == ".." {
		return def
	}
	return s
}

func (m *Meta) normalize() {
	m.GameName = clean(m.GameName, 120, "unknown")
	m.Platform = clean(m.Platform, 40, "PC")
	m.FileName = clean(filepath.Base(strings.ReplaceAll(m.FileName, "\\", "/")), 160, "backup.bin")
	if m.Kind != "game" {
		m.Kind = "save"
	}
	m.Hash = clean(m.Hash, 128, "")
	if m.Timestamp <= 0 {
		m.Timestamp = time.Now().Unix()
	}
}

// Precheck runs before receiving a multipart body: plan, quota and physical room.
func (s *Service) Precheck(ctx context.Context, u *models.User, size int64) error {
	if size < 0 || size > uploads.MaxFileSize {
		return ErrInvalidSize
	}
	unlock := s.lockUser(u.ID)
	err := s.checkQuota(u, size, "")
	unlock()
	if err != nil {
		return err
	}
	if s.target() == "" {
		return ErrNoBackend
	}
	return s.checkCapacity(ctx, size)
}

// StagingPath returns a fresh path in the staging folder for a multipart upload.
func (s *Service) StagingPath() string {
	return filepath.Join(s.cfg.stagingDir(), fmt.Sprintf("in-%d-%d.part", time.Now().UnixNano(), os.Getpid()))
}

// ---------------------------------------------------------------------------- chunked sessions

// StartSession reserves size bytes of the user's quota and opens a resumable upload.
func (s *Service) StartSession(ctx context.Context, u *models.User, meta Meta, size int64) (*models.BackupUploadSession, error) {
	meta.normalize()
	if size <= 0 || size > uploads.MaxFileSize {
		return nil, ErrInvalidSize
	}
	if s.target() == "" {
		return nil, ErrNoBackend
	}
	if err := s.checkCapacity(ctx, size); err != nil {
		return nil, err
	}
	unlock := s.lockUser(u.ID)
	defer unlock()
	if err := s.checkQuota(u, size, ""); err != nil {
		return nil, err
	}
	up, err := s.uploads.Start(u.ID, meta.FileName, size)
	if err != nil {
		return nil, err
	}
	sess := &models.BackupUploadSession{
		ID: up.ID, UserID: u.ID, Size: size, FileName: meta.FileName, GameName: meta.GameName,
		Platform: meta.Platform, Kind: meta.Kind, Hash: meta.Hash, Timestamp: meta.Timestamp, CreatedAt: time.Now(),
	}
	if err := database.DB.Create(sess).Error; err != nil {
		s.uploads.Done(up.ID)
		return nil, err
	}
	return sess, nil
}

// SessionState is returned to the client to resume.
type SessionState struct {
	ID        string `json:"id"`
	Size      int64  `json:"size"`
	Received  int64  `json:"received"`
	ChunkSize int64  `json:"chunk_size"`
}

func (s *Service) session(userID uint, id string) (*models.BackupUploadSession, error) {
	var sess models.BackupUploadSession
	if !found(database.DB.Where("id = ? AND user_id = ?", id, userID), &sess) {
		return nil, uploads.ErrNotFound
	}
	return &sess, nil
}

func (s *Service) SessionStatus(userID uint, id string) (SessionState, error) {
	if _, err := s.session(userID, id); err != nil {
		return SessionState{}, err
	}
	up, err := s.uploads.Get(userID, id)
	if err != nil {
		return SessionState{}, err
	}
	return SessionState{ID: id, Size: up.Size, Received: up.Received, ChunkSize: ClientChunk}, nil
}

// AppendChunk writes one chunk. The plan is re-checked on every chunk (a cancelled plan stops
// the upload) and the uploads manager refuses anything past the reserved size.
func (s *Service) AppendChunk(u *models.User, id string, offset int64, chunk []byte) (SessionState, error) {
	if _, err := s.session(u.ID, id); err != nil {
		return SessionState{}, err
	}
	if !CanUpload(u, time.Now()) {
		s.CancelSession(u.ID, id)
		return SessionState{}, ErrNoPlan
	}
	up, err := s.uploads.Append(u.ID, id, offset, chunk)
	st := SessionState{ID: id, ChunkSize: ClientChunk}
	if up != nil {
		st.Size, st.Received = up.Size, up.Received
	}
	return st, err
}

func (s *Service) CancelSession(userID uint, id string) {
	if _, err := s.session(userID, id); err != nil {
		return
	}
	s.uploads.Done(id)
	database.DB.Where("id = ?", id).Delete(&models.BackupUploadSession{})
}

// CompleteSession hashes the received file, re-checks the quota and records the backup.
func (s *Service) CompleteSession(ctx context.Context, u *models.User, id string) (*models.GameSave, error) {
	sess, err := s.session(u.ID, id)
	if err != nil {
		return nil, err
	}
	path, up, err := s.uploads.Take(u.ID, id)
	if err != nil {
		return nil, err
	}
	meta := Meta{GameName: sess.GameName, Platform: sess.Platform, Kind: sess.Kind, FileName: sess.FileName, Hash: sess.Hash, Timestamp: sess.Timestamp}
	save, err := s.ingestAndRetain(u, meta, path, up.Size, id)
	if err != nil && !isQuotaErr(err) {
		return nil, err // keep the session: the client can retry the completion
	}
	s.uploads.Done(id)
	database.DB.Where("id = ?", id).Delete(&models.BackupUploadSession{})
	return save, err
}

func isQuotaErr(err error) bool {
	var q *ErrQuota
	return errors.As(err, &q) || errors.Is(err, ErrNoPlan)
}

// IngestFile records a file already written to path (multipart upload). path is consumed.
func (s *Service) IngestFile(u *models.User, meta Meta, path string) (*models.GameSave, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	save, err := s.ingestAndRetain(u, meta, path, st.Size(), "")
	if err != nil {
		os.Remove(path)
	}
	return save, err
}

func (s *Service) ingestAndRetain(u *models.User, meta Meta, path string, declared int64, session string) (*models.GameSave, error) {
	save, err := s.ingest(u, meta, path, declared, session)
	if err == nil {
		s.applyRetention(u, save.GameName, save.Kind)
		s.Wake()
	}
	return save, err
}

func hashFile(path string) (sha, md string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()
	h1, h2 := sha256.New(), md5.New()
	size, err = io.Copy(io.MultiWriter(h1, h2), f)
	return hex.EncodeToString(h1.Sum(nil)), hex.EncodeToString(h2.Sum(nil)), size, err
}

// ingest: hash → quota → dedup → GameSave → retention. path is moved to staging or removed.
func (s *Service) ingest(u *models.User, meta Meta, path string, declared int64, session string) (*models.GameSave, error) {
	meta.normalize()
	sha, md, size, err := hashFile(path)
	if err != nil {
		return nil, err
	}
	if size != declared {
		os.Remove(path)
		return nil, fmt.Errorf("arquivo incompleto: recebidos %d de %d bytes", size, declared)
	}

	unlock := s.lockUser(u.ID)
	defer unlock()
	if err := s.checkQuota(u, size, session); err != nil {
		os.Remove(path)
		return nil, err
	}

	s.gcMu.RLock()
	defer s.gcMu.RUnlock()

	var save models.GameSave
	err = database.DB.Transaction(func(tx *gorm.DB) error {
		var blob models.BackupBlob
		hit := found(tx.Where("sha256 = ?", sha), &blob)
		if hit && blob.Status != models.BlobStored && !exists(blob.StagingPath) {
			// The queued copy got lost (disk cleanup): take this one instead.
			dst := filepath.Join(s.cfg.stagingDir(), sha)
			if err := moveFile(path, dst); err != nil {
				return err
			}
			blob.StagingPath, blob.Status, blob.NextTryAt = dst, models.BlobQueued, time.Time{}
			if err := tx.Save(&blob).Error; err != nil {
				return err
			}
		} else if hit {
			os.Remove(path) // dedup: same bytes already stored or queued
		} else {
			dst := filepath.Join(s.cfg.stagingDir(), sha)
			if err := moveFile(path, dst); err != nil {
				return err
			}
			blob = models.BackupBlob{
				SHA256: sha, MD5: md, Size: size, Status: models.BlobQueued, StagingPath: dst,
				OwnerUserID: u.ID, FileName: driveName(meta, sha),
			}
			if err := tx.Create(&blob).Error; err != nil {
				return err
			}
		}
		if hit && !blob.Shared && blob.OwnerUserID != u.ID {
			// Second user with the same file: it moves to the shared folder (janitor/worker).
			if err := tx.Model(&blob).Update("shared", true).Error; err != nil {
				return err
			}
		}
		save = models.GameSave{
			UserID: u.ID, GameName: meta.GameName, Platform: meta.Platform, Kind: meta.Kind,
			FileName: meta.FileName, Hash: firstNonEmpty(meta.Hash, sha), Timestamp: meta.Timestamp,
			Size: size, BlobID: blob.ID,
		}
		if err := tx.Create(&save).Error; err != nil {
			return err
		}
		if blob.Status == models.BlobStored {
			save.Status = models.BlobStored
		} else {
			save.Status = models.BlobQueued
		}
		return nil
	})
	if err != nil {
		os.Remove(path)
		return nil, err
	}
	return &save, nil
}

// applyRetention keeps the newest N versions of one game (N by plan) and drops the rest.
func (s *Service) applyRetention(u *models.User, game, kind string) {
	keep := s.cfg.versionsFor(u.SubscriptionPlan)
	var old []models.GameSave
	database.DB.Where("user_id = ? AND game_name = ? AND kind = ?", u.ID, game, kind).
		Order("timestamp DESC, id DESC").Offset(keep).Find(&old)
	for i := range old {
		s.deleteSaveRow(&old[i])
	}
}

func driveName(m Meta, sha string) string {
	ext := filepath.Ext(m.FileName)
	if len(ext) > 12 {
		ext = ""
	}
	return clean(fmt.Sprintf("%s [%s] %s %s%s", m.GameName, m.Platform,
		time.Unix(m.Timestamp, 0).UTC().Format("2006-01-02 150405"), sha[:12], ext), 200, sha+ext)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func exists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// moveFile renames, falling back to copy+delete across filesystems.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	out, err := os.Create(dst + ".tmp")
	if err != nil {
		in.Close()
		return err
	}
	_, err = io.Copy(out, in)
	in.Close()
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst + ".tmp")
		return err
	}
	if err := os.Rename(dst+".tmp", dst); err != nil {
		return err
	}
	return os.Remove(src)
}

// ---------------------------------------------------------------------------- list / delete

// List returns the user's backups with their storage status.
func (s *Service) List(userID uint) []models.GameSave {
	var saves []models.GameSave
	database.DB.Where("user_id = ?", userID).Order("timestamp desc").Find(&saves)
	ids := []uint{}
	for _, sv := range saves {
		if sv.BlobID != 0 {
			ids = append(ids, sv.BlobID)
		}
	}
	status := map[uint]string{}
	if len(ids) > 0 {
		var blobs []models.BackupBlob
		database.DB.Select("id", "status").Where("id IN ?", ids).Find(&blobs)
		for _, b := range blobs {
			status[b.ID] = b.Status
		}
	}
	for i := range saves {
		saves[i].Status = models.BlobStored
		if st, ok := status[saves[i].BlobID]; ok && st != models.BlobStored {
			saves[i].Status = models.BlobQueued
		}
		if saves[i].BlobID != 0 {
			saves[i].Filename = "" // server paths are not the client's business
		}
	}
	return saves
}

// Get returns one backup of the user.
func (s *Service) Get(userID uint, id string) (*models.GameSave, error) {
	var save models.GameSave
	if !found(database.DB.Where("id = ? AND user_id = ?", id, userID), &save) {
		return nil, ErrNotFound
	}
	return &save, nil
}

// Delete removes one backup of the user (bytes go when no other backup uses them).
func (s *Service) Delete(userID uint, id string) error {
	save, err := s.Get(userID, id)
	if err != nil {
		return err
	}
	return s.deleteSaveRow(save)
}

// deleteSaveRow drops the backup and, when nothing else uses its bytes, the stored file.
// A failed Drive delete is retried by the janitor (the blob stays as an orphan until then).
func (s *Service) deleteSaveRow(save *models.GameSave) error {
	if save.BlobID == 0 && save.Filename != "" {
		if err := os.Remove(save.Filename); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := database.DB.Unscoped().Delete(&models.GameSave{}, save.ID).Error; err != nil {
		return err
	}
	if save.BlobID != 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = s.gcBlob(ctx, save.BlobID)
	}
	return nil
}
