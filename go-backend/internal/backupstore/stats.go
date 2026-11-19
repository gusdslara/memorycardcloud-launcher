package backupstore

import (
	"context"
	"time"

	"go-backend/database"
	"go-backend/models"
)

// Stats is the superadmin view of the backup storage (capacity planning and overcommit).
type Stats struct {
	Backend         string  `json:"backend"`        // where new backups go now: drive | local | "" (Drive required, not connected)
	DriveWriteOK    *bool   `json:"drive_write_ok"` // nil = not tested yet
	LastError       string  `json:"last_error,omitempty"`
	Users           int64   `json:"users"`          // accounts with backups
	ActivePlans     int64   `json:"active_plans"`   // accounts with an active cloud plan
	SoldBytes       int64   `json:"sold_bytes"`     // sum of the quotas of active plans
	LogicalBytes    int64   `json:"logical_bytes"`  // what users are charged for
	PhysicalBytes   int64   `json:"physical_bytes"` // what is really stored (after dedup)
	DedupSavedBytes int64   `json:"dedup_saved_bytes"`
	SharedBlobs     int64   `json:"shared_blobs"`
	CapacityBytes   int64   `json:"capacity_bytes"` // backend total (0 = unknown)
	FreeBytes       int64   `json:"free_bytes"`     // left for backups after the reserve (−1 = unknown)
	Overcommit      float64 `json:"overcommit"`     // sold / capacity
	UsageRatio      float64 `json:"usage_ratio"`    // physical / capacity
	QueuedFiles     int64   `json:"queued_files"`
	QueuedBytes     int64   `json:"queued_bytes"`
	FailedFiles     int64   `json:"failed_files"`
	Uploaded24h     int64   `json:"uploaded_24h"`
	DailyBudget     int64   `json:"daily_budget"`
	UsersOverQuota  int64   `json:"users_over_quota"`
	GraceDays       int     `json:"grace_days"`
	Alert           string  `json:"alert,omitempty"`
}

func (s *Service) Stats(ctx context.Context) Stats {
	st := Stats{Backend: s.target(), DailyBudget: s.cfg.DailyUploadBudget, GraceDays: int(s.cfg.GracePeriod / (24 * time.Hour))}
	s.stateMu.Lock()
	st.DriveWriteOK, st.LastError = s.writeOK, s.lastError
	s.stateMu.Unlock()

	db := database.DB
	db.Model(&models.GameSave{}).Distinct("user_id").Count(&st.Users)
	db.Model(&models.GameSave{}).Select("COALESCE(SUM(size), 0)").Scan(&st.LogicalBytes)
	db.Model(&models.BackupBlob{}).Select("COALESCE(SUM(size), 0)").Scan(&st.PhysicalBytes)
	var legacy int64
	db.Model(&models.GameSave{}).Where("blob_id = 0").Select("COALESCE(SUM(size), 0)").Scan(&legacy)
	st.PhysicalBytes += legacy
	st.DedupSavedBytes = max(0, st.LogicalBytes-st.PhysicalBytes)
	db.Model(&models.BackupBlob{}).Where("shared = ?", true).Count(&st.SharedBlobs)
	db.Model(&models.BackupBlob{}).Where("status <> ?", models.BlobStored).Count(&st.QueuedFiles)
	db.Model(&models.BackupBlob{}).Where("status <> ?", models.BlobStored).Select("COALESCE(SUM(size), 0)").Scan(&st.QueuedBytes)
	db.Model(&models.BackupBlob{}).Where("status = ?", models.BlobFailed).Count(&st.FailedFiles)
	db.Model(&models.BackupAccount{}).Where("over_quota_since IS NOT NULL").Count(&st.UsersOverQuota)
	st.Uploaded24h = uploadedLast24h()

	now := time.Now()
	var users []models.User
	db.Where("subscription_status = ? AND is_admin = ?", "active", false).Find(&users)
	for i := range users {
		// Sold space = paying customers only (the owner's/admin accounts are not sold).
		if CanUpload(&users[i], now) {
			st.ActivePlans++
			st.SoldBytes += EffectiveLimit(&users[i], now)
		}
	}

	free, total := s.capacity(ctx)
	st.FreeBytes, st.CapacityBytes = free, total
	if total > 0 {
		st.Overcommit = float64(st.SoldBytes) / float64(total)
		st.UsageRatio = float64(st.PhysicalBytes) / float64(total)
	}
	switch {
	case st.Backend == "":
		st.Alert = "O Google Drive não está conectado: novos backups estão recusados."
	case st.DriveWriteOK != nil && !*st.DriveWriteOK:
		st.Alert = "O Google Drive foi conectado sem permissão de gravação: reconecte para liberar os backups."
	case total > 0 && st.UsageRatio >= 0.85:
		st.Alert = "Uso físico acima de 85%: pare de vender planos grandes ou aumente o armazenamento."
	case total > 0 && st.Overcommit >= 4:
		st.Alert = "Overcommit acima de 4x: revise a venda de planos."
	case st.FailedFiles > 0:
		st.Alert = "Há arquivos que falharam ao enviar para o Drive (o janitor tenta de novo)."
	}
	return st
}
