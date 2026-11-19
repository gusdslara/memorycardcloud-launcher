package backupstore

import (
	"context"
	"errors"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/models"
)

// JanitorReport says what one janitor pass did (admin "run now" button and logs).
type JanitorReport struct {
	OrphansDeleted  int   `json:"orphans_deleted"`
	SharedMoved     int   `json:"shared_moved"`
	UsersOverQuota  int   `json:"users_over_quota"`
	UsersPurged     int   `json:"users_purged"`
	BytesPurged     int64 `json:"bytes_purged"`
	FoldersDeleted  int   `json:"folders_deleted"`
	LegacyAdopted   int   `json:"legacy_adopted"`
	LocalPromoted   int   `json:"local_promoted"`
	SessionsExpired int   `json:"sessions_expired"`
}

// Janitor runs every maintenance task once.
func (s *Service) Janitor(ctx context.Context) JanitorReport {
	var r JanitorReport
	r.SessionsExpired = s.expireSessions()
	r.OrphansDeleted = s.gcOrphans(ctx)
	r.SharedMoved = s.moveShared(ctx)
	r.UsersOverQuota, r.UsersPurged, r.BytesPurged = s.enforceQuotas(ctx)
	r.FoldersDeleted = s.deleteEmptyUserFolders(ctx)
	if s.target() == models.BackendDrive {
		r.LegacyAdopted = s.adoptLegacy(50)
		r.LocalPromoted = s.promoteLocal(50)
	}
	if r != (JanitorReport{}) {
		log.Printf("[backups] janitor: %+v", r)
		s.Wake()
	}
	return r
}

func (s *Service) expireSessions() int {
	var old []models.BackupUploadSession
	database.DB.Where("created_at < ?", time.Now().Add(-48*time.Hour)).Find(&old)
	for _, o := range old {
		s.uploads.Done(o.ID)
		database.DB.Delete(&o)
	}
	return len(old)
}

// gcBlob deletes a blob (row + bytes) when no backup references it anymore.
func (s *Service) gcBlob(ctx context.Context, id uint) error {
	s.gcMu.Lock()
	var refs int64
	database.DB.Model(&models.GameSave{}).Where("blob_id = ?", id).Count(&refs)
	var b models.BackupBlob
	if refs > 0 || !found(database.DB.Where("id = ?", id), &b) {
		s.gcMu.Unlock()
		return nil
	}
	if _, busy := s.claimed.Load(id); busy {
		s.gcMu.Unlock()
		return errors.New("blob sendo enviado; o janitor apaga depois")
	}
	// Remove the row first (under the lock, so no ingest can attach to it), then the bytes.
	database.DB.Delete(&models.BackupBlob{}, id)
	s.gcMu.Unlock()

	if b.StagingPath != "" {
		os.Remove(b.StagingPath)
	}
	if b.Backend == models.BackendLocal && b.LocalPath != "" {
		os.Remove(b.LocalPath)
	}
	if b.Backend == models.BackendDrive && b.DriveFileID != "" {
		d := s.driveService()
		var err error
		if d == nil {
			err = ErrNoBackend
		} else {
			err = d.DeleteFile(ctx, b.DriveFileID)
		}
		if err != nil {
			// Put it back as an orphan so the next janitor pass retries the Drive delete.
			b.LastError = "apagar no Drive: " + err.Error()
			database.DB.Create(&b)
			return err
		}
	}
	return nil
}

func (s *Service) gcOrphans(ctx context.Context) int {
	var ids []uint
	database.DB.Model(&models.BackupBlob{}).
		Where("created_at < ? AND NOT EXISTS (SELECT 1 FROM game_saves g WHERE g.blob_id = backup_blobs.id AND g.deleted_at IS NULL)",
			time.Now().Add(-s.cfg.GCMinAge)).
		Limit(500).Pluck("id", &ids)
	// Soft-deleted backups (old code paths) do not hold bytes: drop them for good first.
	n := 0
	for _, id := range ids {
		database.DB.Unscoped().Where("blob_id = ? AND deleted_at IS NOT NULL", id).Delete(&models.GameSave{})
		if s.gcBlob(ctx, id) == nil {
			n++
		}
	}
	return n
}

// moveShared moves blobs used by 2+ users out of the first owner's folder.
func (s *Service) moveShared(ctx context.Context) int {
	var blobs []models.BackupBlob
	database.DB.Where("shared = ? AND status = ? AND backend = ?", true, models.BlobStored, models.BackendDrive).Find(&blobs)
	if len(blobs) == 0 {
		return 0
	}
	d := s.driveService()
	if d == nil {
		return 0
	}
	shared, err := s.folder(ctx, d, "shared")
	if err != nil {
		s.setError(err)
		return 0
	}
	n := 0
	for _, b := range blobs {
		if b.DriveFolder == shared {
			continue
		}
		if err := d.MoveFile(ctx, b.DriveFileID, b.DriveFolder, shared, b.SHA256+extOf(b.FileName)); err != nil {
			s.setError(err)
			continue
		}
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Update("drive_folder", shared)
		n++
	}
	return n
}

func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 && len(name)-i <= 12 {
		return name[i:]
	}
	return ""
}

// enforceQuotas tracks accounts above their limit (downgrade, cancellation, expiry) and, after the
// grace period, deletes their oldest versions first, then the oldest backups, until they fit.
func (s *Service) enforceQuotas(ctx context.Context) (over, purged int, bytes int64) {
	type row struct {
		UserID uint
		Used   int64
	}
	var rows []row
	database.DB.Model(&models.GameSave{}).Select("user_id, SUM(size) AS used").Group("user_id").Scan(&rows)
	now := time.Now()
	for _, r := range rows {
		var u models.User
		if !found(database.DB.Where("id = ?", r.UserID), &u) {
			// Account deleted (LGPD): its backups go now.
			bytes += s.purgeUser(r.UserID, 0)
			purged++
			continue
		}
		limit := EffectiveLimit(&u, now)
		var acc models.BackupAccount
		database.DB.FirstOrInit(&acc, models.BackupAccount{UserID: u.ID})
		if r.Used <= limit {
			if acc.OverQuotaSince != nil {
				acc.OverQuotaSince = nil
				database.DB.Save(&acc)
			}
			continue
		}
		over++
		if acc.OverQuotaSince == nil {
			acc.OverQuotaSince = &now
			database.DB.Save(&acc)
			continue
		}
		if now.Sub(*acc.OverQuotaSince) < s.cfg.GracePeriod {
			continue
		}
		freed := s.purgeUser(u.ID, limit)
		acc.PurgedBytes += freed
		acc.OverQuotaSince = nil
		database.DB.Save(&acc)
		purged++
		bytes += freed
		log.Printf("[backups] usuário %d acima da cota após %s de carência: %s liberados", u.ID, s.cfg.GracePeriod, gdrive.FormatBytes(freed))
	}
	return
}

// purgeUser deletes backups until the user's usage is ≤ limit: older versions of every game
// first (oldest first), then the newest versions (oldest first). Returns bytes freed.
func (s *Service) purgeUser(userID uint, limit int64) int64 {
	var saves []models.GameSave
	database.DB.Where("user_id = ?", userID).Order("timestamp DESC, id DESC").Find(&saves)
	var used int64
	latest := map[string]bool{}
	var olds, newest []models.GameSave
	for _, sv := range saves {
		used += sv.Size
		k := sv.Kind + "\x00" + sv.GameName
		if latest[k] {
			olds = append(olds, sv)
		} else {
			latest[k] = true
			newest = append(newest, sv)
		}
	}
	byAge := func(l []models.GameSave) {
		sort.SliceStable(l, func(i, j int) bool { return l[i].Timestamp < l[j].Timestamp })
	}
	byAge(olds)
	byAge(newest)
	var freed int64
	for _, sv := range append(olds, newest...) {
		if used <= limit {
			break
		}
		sv := sv
		if s.deleteSaveRow(&sv) == nil {
			used -= sv.Size
			freed += sv.Size
		}
	}
	return freed
}

// deleteEmptyUserFolders removes "users/u<ID>" folders with nothing of the user left.
// A Drive folder delete also deletes its children, so it only happens when no blob lives there.
func (s *Service) deleteEmptyUserFolders(ctx context.Context) int {
	var folders []models.BackupFolder
	database.DB.Where("key LIKE ?", "user:%").Find(&folders)
	if len(folders) == 0 {
		return 0
	}
	d := s.driveService()
	if d == nil {
		return 0
	}
	n := 0
	for _, f := range folders {
		id, err := strconv.ParseUint(strings.TrimPrefix(f.Key, "user:"), 10, 64)
		if err != nil {
			continue
		}
		var saves, blobs int64
		database.DB.Unscoped().Model(&models.GameSave{}).Where("user_id = ?", id).Count(&saves)
		database.DB.Model(&models.BackupBlob{}).Where("drive_folder = ? OR (owner_user_id = ? AND shared = ? AND status <> ?)",
			f.DriveID, id, false, models.BlobStored).Count(&blobs)
		if saves > 0 || blobs > 0 {
			continue
		}
		if err := d.DeleteFile(ctx, f.DriveID); err != nil {
			s.setError(err)
			continue
		}
		database.DB.Delete(&f)
		n++
	}
	return n
}

// adoptLegacy moves backups saved on the server disk by the old code to the blob store, so the
// worker sends them to the Drive and frees the VPS disk.
func (s *Service) adoptLegacy(limit int) int {
	var saves []models.GameSave
	database.DB.Where("blob_id = 0 AND filename <> ''").Limit(limit).Find(&saves)
	n := 0
	for _, sv := range saves {
		if !exists(sv.Filename) {
			continue
		}
		sha, md, size, err := hashFile(sv.Filename)
		if err != nil {
			continue
		}
		s.gcMu.RLock()
		var b models.BackupBlob
		if !found(database.DB.Where("sha256 = ?", sha), &b) {
			dst := s.cfg.stagingDir() + string(os.PathSeparator) + sha
			if moveFile(sv.Filename, dst) != nil {
				s.gcMu.RUnlock()
				continue
			}
			b = models.BackupBlob{SHA256: sha, MD5: md, Size: size, Status: models.BlobQueued, StagingPath: dst,
				OwnerUserID: sv.UserID, FileName: driveName(Meta{GameName: sv.GameName, Platform: sv.Platform, FileName: sv.Filename, Timestamp: sv.Timestamp}, sha)}
			database.DB.Create(&b)
		} else {
			os.Remove(sv.Filename)
			if b.OwnerUserID != sv.UserID && !b.Shared {
				database.DB.Model(&b).Update("shared", true)
			}
		}
		database.DB.Model(&models.GameSave{}).Where("id = ?", sv.ID).Updates(map[string]any{
			"blob_id": b.ID, "size": size, "filename": "", "file_name": baseName(sv.Filename),
		})
		s.gcMu.RUnlock()
		n++
	}
	return n
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// promoteLocal queues blobs kept on the server disk (Drive was offline) for the Drive upload.
func (s *Service) promoteLocal(limit int) int {
	var blobs []models.BackupBlob
	database.DB.Where("status = ? AND backend = ?", models.BlobStored, models.BackendLocal).Limit(limit).Find(&blobs)
	for _, b := range blobs {
		database.DB.Model(&models.BackupBlob{}).Where("id = ?", b.ID).Updates(map[string]any{
			"status": models.BlobQueued, "staging_path": b.LocalPath, "next_try_at": time.Time{},
		})
	}
	return len(blobs)
}
