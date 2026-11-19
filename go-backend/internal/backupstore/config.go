// Package backupstore keeps the users' cloud backups (saves and game copies) on the owner's
// Google Drive (or on the server disk when the Drive is not connected).
//
// Flow: the app/site sends the file to the API (multipart for small saves, chunked + resumable
// for big files) → the server checks the plan quota before and during the upload → the file
// lands in the staging folder, is hashed (SHA-256) and deduplicated → a worker pushes it to the
// Drive with the resumable protocol, under the 750 GB/24 h budget → a janitor deletes blobs
// nobody references, moves shared blobs, prunes old versions and cleans accounts that stayed
// over quota after a plan downgrade or cancellation.
//
// Drive layout (all created by the server, scope drive.file):
//
//	MemoryCard Backups/
//	  users/u<ID>/   files only that user has
//	  shared/        identical files referenced by 2+ users (stored once)
package backupstore

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Backend           string        // auto | drive | local
	DataDir           string        // staging + local blobs
	RootName          string        // Drive root folder
	DailyUploadBudget int64         // bytes per rolling 24 h sent to the Drive (Google limit: 750 GB)
	CapacityBytes     int64         // physical capacity override (0 = ask the Drive / disk)
	ReserveRatio      float64       // capacity kept free (Drive versions, metadata, safety)
	StagingMinFree    int64         // free disk the server keeps while receiving files
	GracePeriod       time.Duration // over quota after downgrade/cancel → cleanup after this
	MaxVersions       int           // 0 = by plan (see versionsFor)
	Workers           int
	JanitorEvery      time.Duration
	GCMinAge          time.Duration // orphan blobs younger than this are kept (in-flight ingest)
}

func envInt(key string, def int64) int64 {
	if v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64); err == nil {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64); err == nil {
		return v
	}
	return def
}

const (
	GB  = int64(1000 * 1000 * 1000)
	GiB = int64(1 << 30)
)

// ConfigFromEnv reads BACKUP_* variables (all optional).
func ConfigFromEnv() Config {
	data := os.Getenv("DATA_DIR")
	if data == "" {
		data = "./data"
	}
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("BACKUP_STORAGE")))
	if backend != "drive" && backend != "local" {
		backend = "auto"
	}
	root := strings.TrimSpace(os.Getenv("BACKUP_DRIVE_ROOT"))
	if root == "" {
		root = "MemoryCard Backups"
	}
	return Config{
		Backend:           backend,
		DataDir:           data,
		RootName:          root,
		DailyUploadBudget: envInt("BACKUP_DRIVE_DAILY_BYTES", 700*GB), // 50 GB below Google's 750 GB
		CapacityBytes:     envInt("BACKUP_CAPACITY_BYTES", 0),
		ReserveRatio:      envFloat("BACKUP_RESERVE_RATIO", 0.10),
		StagingMinFree:    envInt("BACKUP_STAGING_MIN_FREE", 10*GiB),
		GracePeriod:       time.Duration(envInt("BACKUP_GRACE_DAYS", 30)) * 24 * time.Hour,
		MaxVersions:       int(envInt("BACKUP_MAX_VERSIONS", 0)),
		Workers:           int(envInt("BACKUP_WORKERS", 2)),
		JanitorEvery:      10 * time.Minute,
		GCMinAge:          10 * time.Minute,
	}
}

func (c Config) stagingDir() string { return filepath.Join(c.DataDir, "backup-staging") }
func (c Config) uploadDir() string  { return filepath.Join(c.DataDir, "backup-upload-tmp") }
func (c Config) localDir() string   { return filepath.Join(c.DataDir, "backup-blobs") }

// versionsFor: how many versions of each game a plan keeps (older ones are pruned).
func (c Config) versionsFor(tier string) int {
	if c.MaxVersions > 0 {
		return c.MaxVersions
	}
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "exclusive":
		return 50
	case "diamond":
		return 20
	case "gold":
		return 10
	}
	return 5
}
