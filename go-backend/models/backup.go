package models

import "time"

// Cloud backups (saves and game copies) of the users.
//
// A GameSave is what the user sees (one version of one game). Its bytes live in a BackupBlob,
// addressed by SHA-256, so the same file sent by many users (or twice by one) is stored once.
// Every user is charged the full size of each GameSave (quota is logical); dedup only saves
// physical space on the owner's Google Drive.

const (
	BlobQueued   = "queued" // received by the server, waiting in staging for the Drive upload
	BlobStored   = "stored" // in the final storage (Drive or local disk)
	BlobFailed   = "failed" // upload gave up (still in staging; retried by the janitor)
	BackendDrive = "drive"
	BackendLocal = "local"
)

type BackupBlob struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	SHA256      string    `gorm:"uniqueIndex;size:64;not null" json:"sha256"`
	MD5         string    `gorm:"size:32" json:"-"`
	Size        int64     `json:"size"`
	Status      string    `gorm:"index;default:'queued'" json:"status"`
	Backend     string    `json:"backend"` // drive | local ("" while queued)
	DriveFileID string    `gorm:"index" json:"-"`
	DriveFolder string    `json:"-"`              // parent folder in the Drive (user folder or shared)
	LocalPath   string    `json:"-"`              // local backend: final path
	StagingPath string    `json:"-"`              // file received by the server, removed after the upload
	SessionURI  string    `json:"-"`              // Drive resumable session (survives restarts, valid ~1 week)
	OwnerUserID uint      `gorm:"index" json:"-"` // first uploader: the blob sits in their folder until shared
	Shared      bool      `json:"shared"`         // referenced by 2+ users → lives in the "shared" folder
	FileName    string    `json:"file_name"`      // name used in the Drive
	Attempts    int       `json:"attempts"`
	LastError   string    `json:"last_error,omitempty"`
	NextTryAt   time.Time `json:"-"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// BackupAccount keeps the per-user state of the backup area (folder and over-quota grace).
type BackupAccount struct {
	UserID         uint       `gorm:"primaryKey" json:"user_id"`
	OverQuotaSince *time.Time `json:"over_quota_since"`
	PurgedBytes    int64      `json:"purged_bytes"` // freed by the over-quota cleanup (audit)
	UpdatedAt      time.Time  `json:"updated_at"`
}

// BackupFolder maps a logical folder ("root", "users", "shared", "user:42") to its Drive ID.
type BackupFolder struct {
	Key       string    `gorm:"primaryKey;size:64" json:"key"`
	DriveID   string    `json:"drive_id"`
	CreatedAt time.Time `json:"created_at"`
}

// BackupUploadSession is a chunked upload in progress; its size is reserved in the quota.
type BackupUploadSession struct {
	ID        string    `gorm:"primaryKey;size:32" json:"id"`
	UserID    uint      `gorm:"index" json:"-"`
	Size      int64     `json:"size"`
	FileName  string    `json:"file_name"`
	GameName  string    `json:"game_name"`
	Platform  string    `json:"platform"`
	Kind      string    `json:"kind"`
	Hash      string    `json:"hash"`
	Timestamp int64     `json:"timestamp"`
	CreatedAt time.Time `json:"created_at"`
}

// DriveUploadLedger records bytes sent to the Drive, to stay under the 750 GB / 24 h limit.
type DriveUploadLedger struct {
	ID    uint      `gorm:"primaryKey"`
	Bytes int64     `json:"bytes"`
	At    time.Time `gorm:"index" json:"at"`
}
