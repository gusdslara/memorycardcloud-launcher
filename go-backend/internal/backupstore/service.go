package backupstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"go-backend/database"
	"go-backend/internal/diskusage"
	"go-backend/internal/gdrive"
	"go-backend/internal/uploads"
	"go-backend/models"

	"gorm.io/gorm"
)

type Service struct {
	cfg     Config
	uploads *uploads.Manager

	driveMu    sync.Mutex
	drive      *gdrive.DriveService
	driveToken string

	wake       chan struct{}
	claimed    sync.Map // blob ID → true while a worker uploads it
	gcMu       sync.RWMutex
	userLocks  sync.Map
	stateMu    sync.Mutex
	pauseUntil time.Time // Drive refused uploads (daily limit) until then
	lastError  string
	writeOK    *bool
	capAt      time.Time
	capFree    int64 // free bytes at the backend (−1 unknown/unlimited)
	capTotal   int64

	// newDrive builds the Drive client from the stored config (swapped in tests).
	newDrive func(cfg models.GoogleDriveConfig) *gdrive.DriveService
}

var (
	defaultMu sync.Mutex
	defaultSv *Service
)

// Default returns the process-wide service (created from env on first use).
func Default() *Service {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultSv == nil {
		defaultSv = New(ConfigFromEnv())
	}
	return defaultSv
}

// SetDefault replaces the process-wide service (tests).
func SetDefault(s *Service) {
	defaultMu.Lock()
	defaultSv = s
	defaultMu.Unlock()
}

func New(cfg Config) *Service {
	for _, d := range []string{cfg.stagingDir(), cfg.uploadDir(), cfg.localDir()} {
		_ = os.MkdirAll(d, 0o755)
	}
	if cfg.Workers <= 0 {
		cfg.Workers = 1
	}
	return &Service{
		cfg:      cfg,
		uploads:  uploads.New(cfg.uploadDir()),
		wake:     make(chan struct{}, 1),
		capFree:  -1,
		newDrive: gdrive.NewDriveService,
	}
}

func (s *Service) Config() Config { return s.cfg }

// Migrate creates the backup tables.
func Migrate() error {
	return database.DB.AutoMigrate(
		&models.GameSave{},
		&models.BackupBlob{},
		&models.BackupAccount{},
		&models.BackupFolder{},
		&models.BackupUploadSession{},
		&models.DriveUploadLedger{},
	)
}

// Wake makes the worker/janitor look at the queue now.
func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) lockUser(id uint) func() {
	m, _ := s.userLocks.LoadOrStore(id, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (s *Service) setError(err error) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if err == nil {
		s.lastError = ""
		return
	}
	s.lastError = err.Error()
	if errors.Is(err, gdrive.ErrNoWriteScope) {
		f := false
		s.writeOK = &f
	}
}

// ---------------------------------------------------------------------------- Drive

// driveService returns the Drive client of the owner's connected account, or nil.
func (s *Service) driveService() *gdrive.DriveService {
	var cfg models.GoogleDriveConfig
	if !found(database.DB.Order("id"), &cfg) || cfg.OAuthRefreshToken == "" {
		return nil
	}
	s.driveMu.Lock()
	defer s.driveMu.Unlock()
	if s.drive == nil || s.driveToken != cfg.OAuthRefreshToken {
		s.drive = s.newDrive(cfg)
		s.driveToken = cfg.OAuthRefreshToken
	}
	return s.drive
}

// target is where new blobs go: "drive" or "local" ("" = Drive required but not connected).
func (s *Service) target() string {
	switch s.cfg.Backend {
	case "local":
		return models.BackendLocal
	case "drive":
		if s.driveService() != nil {
			return models.BackendDrive
		}
		return ""
	}
	if s.driveService() != nil {
		return models.BackendDrive
	}
	return models.BackendLocal
}

// folder finds/creates a logical folder in the Drive, cached in backup_folders.
func (s *Service) folder(ctx context.Context, d *gdrive.DriveService, key string) (string, error) {
	var f models.BackupFolder
	if found(database.DB.Where("key = ?", key), &f) && f.DriveID != "" {
		return f.DriveID, nil
	}
	var name, parentKey string
	switch {
	case key == "root":
		name = s.cfg.RootName
	case key == "users" || key == "shared":
		name, parentKey = key, "root"
	case strings.HasPrefix(key, "user:"):
		name, parentKey = "u"+strings.TrimPrefix(key, "user:"), "users"
	default:
		return "", fmt.Errorf("pasta desconhecida %q", key)
	}
	parent := ""
	if parentKey != "" {
		p, err := s.folder(ctx, d, parentKey)
		if err != nil {
			return "", err
		}
		parent = p
	}
	id, err := d.EnsureFolder(ctx, name, parent)
	if err != nil {
		return "", err
	}
	database.DB.Save(&models.BackupFolder{Key: key, DriveID: id, CreatedAt: time.Now()})
	return id, nil
}

// found loads the first row of q into dst (Find+Limit: no "record not found" noise in the logs).
func found(q *gorm.DB, dst any) bool {
	return q.Limit(1).Find(dst).RowsAffected > 0
}

func userFolderKey(id uint) string { return fmt.Sprintf("user:%d", id) }

// ---------------------------------------------------------------------------- quota

// ErrQuota: the upload does not fit the plan.
type ErrQuota struct {
	Used, Reserved, Limit, Need int64
	OverQuota                   bool
}

func (e *ErrQuota) Error() string {
	if e.OverQuota {
		return "Seu espaço de backup está acima do limite do plano. Apague backups ou mude de plano para enviar novos."
	}
	return fmt.Sprintf("Sem espaço no seu plano: usados %s de %s, este envio precisa de %s.",
		gdrive.FormatBytes(e.Used+e.Reserved), gdrive.FormatBytes(e.Limit), gdrive.FormatBytes(e.Need))
}

var (
	ErrNoPlan      = errors.New("É preciso ter um plano de backup ativo para enviar arquivos.")
	ErrServerFull  = errors.New("O armazenamento de backups está cheio no momento. Tente de novo mais tarde.")
	ErrServerBusy  = errors.New("O servidor está sem espaço temporário para receber arquivos agora. Tente de novo em alguns minutos.")
	ErrNoBackend   = errors.New("O armazenamento de backups (Google Drive) não está conectado.")
	ErrNotFound    = errors.New("Backup não encontrado")
	ErrInvalidSize = errors.New("Tamanho de arquivo inválido")
)

// EffectiveLimit is the quota in bytes: the plan limit while the plan is active, the free limit
// otherwise (cancelled/expired plans keep only that much after the grace period).
func EffectiveLimit(u *models.User, now time.Time) int64 {
	plan := models.GetPlanStorageLimit(u.SubscriptionPlan)
	if u.IsAdmin {
		if u.StorageLimit > plan {
			return u.StorageLimit
		}
		return plan
	}
	if u.HasActiveCloudPlan(now) {
		if u.StorageLimit > 0 {
			return u.StorageLimit
		}
		return plan
	}
	return models.GetPlanStorageLimit("free")
}

// CanUpload: an active cloud plan (or admin) is required to send backups.
func CanUpload(u *models.User, now time.Time) bool {
	return u.IsAdmin || u.HasActiveCloudPlan(now)
}

func usedBytes(userID uint) int64 {
	var n int64
	database.DB.Model(&models.GameSave{}).Where("user_id = ?", userID).Select("COALESCE(SUM(size), 0)").Scan(&n)
	return n
}

func reservedBytes(userID uint, except string) int64 {
	var n int64
	q := database.DB.Model(&models.BackupUploadSession{}).
		Where("user_id = ? AND created_at > ?", userID, time.Now().Add(-48*time.Hour))
	if except != "" {
		q = q.Where("id <> ?", except)
	}
	q.Select("COALESCE(SUM(size), 0)").Scan(&n)
	return n
}

// checkQuota must be called with the user lock held.
func (s *Service) checkQuota(u *models.User, size int64, exceptSession string) error {
	now := time.Now()
	if !CanUpload(u, now) {
		return ErrNoPlan
	}
	limit := EffectiveLimit(u, now)
	used := usedBytes(u.ID)
	reserved := reservedBytes(u.ID, exceptSession)
	if used > limit {
		return &ErrQuota{Used: used, Reserved: reserved, Limit: limit, Need: size, OverQuota: true}
	}
	if used+reserved+size > limit {
		return &ErrQuota{Used: used, Reserved: reserved, Limit: limit, Need: size}
	}
	return nil
}

// checkCapacity: physical room at the backend and on the server disk (staging) for size bytes.
func (s *Service) checkCapacity(ctx context.Context, size int64) error {
	if du, err := diskusage.Of(s.cfg.stagingDir()); err == nil && int64(du.Free) < size+s.cfg.StagingMinFree {
		return ErrServerBusy
	}
	free, _ := s.capacity(ctx)
	if free < 0 {
		return nil // unknown / unlimited
	}
	var queued int64
	database.DB.Model(&models.BackupBlob{}).Where("status <> ?", models.BlobStored).Select("COALESCE(SUM(size), 0)").Scan(&queued)
	if queued+size > free {
		return ErrServerFull
	}
	return nil
}

// capacity returns (free, total) bytes left at the backend minus the reserve, cached 10 min.
// free −1 = unknown/unlimited.
func (s *Service) capacity(ctx context.Context) (int64, int64) {
	s.stateMu.Lock()
	if time.Since(s.capAt) < 10*time.Minute && !s.capAt.IsZero() {
		f, t := s.capFree, s.capTotal
		s.stateMu.Unlock()
		return f, t
	}
	s.stateMu.Unlock()

	free, total := int64(-1), int64(0)
	if s.cfg.CapacityBytes > 0 {
		var physical int64
		database.DB.Model(&models.BackupBlob{}).Where("status = ?", models.BlobStored).Select("COALESCE(SUM(size), 0)").Scan(&physical)
		total = s.cfg.CapacityBytes
		free = total - physical
	} else if s.target() == models.BackendDrive {
		if d := s.driveService(); d != nil {
			c, cancel := context.WithTimeout(ctx, 20*time.Second)
			q, err := d.StorageQuota(c)
			cancel()
			if err == nil && q.Limit > 0 {
				total, free = q.Limit, q.Limit-q.Usage
			}
		}
	} else if du, err := diskusage.Of(s.cfg.localDir()); err == nil {
		total, free = int64(du.Total), int64(du.Free)
	}
	if free >= 0 {
		free -= int64(float64(total) * s.cfg.ReserveRatio)
		if free < 0 {
			free = 0
		}
	}
	s.stateMu.Lock()
	s.capAt, s.capFree, s.capTotal = time.Now(), free, total
	s.stateMu.Unlock()
	return free, total
}

// Usage is what the app and the site show in the backup area.
type Usage struct {
	Used        int64      `json:"used"`
	Reserved    int64      `json:"reserved"`
	Limit       int64      `json:"limit"`
	Free        int64      `json:"free"`
	CanUpload   bool       `json:"can_upload"`
	OverQuota   bool       `json:"over_quota"`
	GraceUntil  *time.Time `json:"grace_until,omitempty"`
	Plan        string     `json:"plan"`
	MaxVersions int        `json:"max_versions"`
	ChunkSize   int64      `json:"chunk_size"`
	MaxFileSize int64      `json:"max_file_size"`
	Queued      int64      `json:"queued"` // own files still waiting for the Drive upload
}

const ClientChunk = int64(16 << 20) // what the app/site send per PUT

func (s *Service) UsageOf(u *models.User) Usage {
	now := time.Now()
	limit := EffectiveLimit(u, now)
	used := usedBytes(u.ID)
	res := reservedBytes(u.ID, "")
	out := Usage{
		Used: used, Reserved: res, Limit: limit, Free: max(0, limit-used-res),
		CanUpload: CanUpload(u, now) && used <= limit, OverQuota: used > limit,
		Plan: u.SubscriptionPlan, MaxVersions: s.cfg.versionsFor(u.SubscriptionPlan),
		ChunkSize: ClientChunk, MaxFileSize: uploads.MaxFileSize,
	}
	var acc models.BackupAccount
	if out.OverQuota && found(database.DB.Where("user_id = ?", u.ID), &acc) && acc.OverQuotaSince != nil {
		g := acc.OverQuotaSince.Add(s.cfg.GracePeriod)
		out.GraceUntil = &g
	}
	database.DB.Model(&models.GameSave{}).
		Joins("JOIN backup_blobs ON backup_blobs.id = game_saves.blob_id").
		Where("game_saves.user_id = ? AND backup_blobs.status <> ?", u.ID, models.BlobStored).
		Count(&out.Queued)
	return out
}
