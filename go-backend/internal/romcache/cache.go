// Package romcache keeps a local SSD copy of the private ROM library.
//
// Google Drive (the superadmin's "roms" folder, one sub-folder per console) is the source of
// truth. The server syncs the list from Drive, mirrors every file to ROMS_CACHE_DIR and serves
// downloads from the SSD; files not cached yet are streamed straight from Drive.
package romcache

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/models"
)

type Status struct {
	Enabled      bool       `json:"enabled"`
	Dir          string     `json:"dir"`
	MaxBytes     int64      `json:"max_bytes"` // 0 = no limit
	Running      bool       `json:"running"`
	Syncing      bool       `json:"syncing"`
	Current      string     `json:"current,omitempty"`
	CurrentBytes int64      `json:"current_bytes"`
	CurrentTotal int64      `json:"current_total"`
	Files        int64      `json:"files"`
	Cached       int64      `json:"cached"`
	Pending      int64      `json:"pending"`
	Errors       int64      `json:"errors"`
	Skipped      int64      `json:"skipped"`
	TotalBytes   int64      `json:"total_bytes"`
	CachedBytes  int64      `json:"cached_bytes"`
	LastPassAt   *time.Time `json:"last_pass_at"`
	LastSyncAt   *time.Time `json:"last_sync_at"`
	LastError    string     `json:"last_error,omitempty"`
}

type Cache struct {
	dir          string
	maxBytes     int64
	enabled      bool
	syncInterval time.Duration

	mu      sync.Mutex
	st      Status
	trigger chan bool // true = sync from Drive first
}

// Default is the process-wide cache started by main.
var Default *Cache

// FromEnv: ROMS_CACHE_DIR (default $DATA_DIR/roms-cache), ROMS_CACHE_MAX_GB (0 = no limit),
// ROMS_CACHE=false disables mirroring, ROMS_SYNC_HOURS (default 6) for the periodic Drive sync.
func FromEnv() *Cache {
	dir := os.Getenv("ROMS_CACHE_DIR")
	if dir == "" {
		base := os.Getenv("DATA_DIR")
		if base == "" {
			base = "./data"
		}
		dir = filepath.Join(base, "roms-cache")
	}
	maxGB, _ := strconv.ParseFloat(os.Getenv("ROMS_CACHE_MAX_GB"), 64)
	hours, _ := strconv.Atoi(os.Getenv("ROMS_SYNC_HOURS"))
	if hours <= 0 {
		hours = 6
	}
	c := &Cache{
		dir:          dir,
		maxBytes:     int64(maxGB * (1 << 30)),
		enabled:      !strings.EqualFold(os.Getenv("ROMS_CACHE"), "false"),
		syncInterval: time.Duration(hours) * time.Hour,
		trigger:      make(chan bool, 1),
	}
	c.st.Enabled, c.st.Dir, c.st.MaxBytes = c.enabled, dir, c.maxBytes
	return c
}

func (c *Cache) Dir() string { return c.dir }

// Trigger asks the worker for a pass (non-blocking). sync=true re-reads the Drive folder first.
func (c *Cache) Trigger(sync bool) {
	select {
	case c.trigger <- sync:
	default:
		if sync { // a pass is already queued: make sure it also syncs
			select {
			case <-c.trigger:
			default:
			}
			select {
			case c.trigger <- true:
			default:
			}
		}
	}
}

// Run loops until ctx ends: periodic Drive sync + mirroring.
func (c *Cache) Run(ctx context.Context) {
	timer := time.NewTimer(20 * time.Second) // let the server boot
	defer timer.Stop()
	for {
		sync := false
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			sync = true
		case sync = <-c.trigger:
		}
		if sync {
			if _, err := c.SyncFromDrive(ctx); err != nil && !strings.Contains(err.Error(), "não conectado") {
				c.setErr(err)
				log.Printf("[roms] sync: %v", err)
			}
		}
		if c.enabled {
			c.pass(ctx)
		}
		timer.Reset(c.syncInterval)
	}
}

func (c *Cache) setErr(err error) {
	c.mu.Lock()
	c.st.LastError = err.Error()
	c.mu.Unlock()
}

// Status returns progress plus totals from the database.
func (c *Cache) Status() Status {
	c.mu.Lock()
	st := c.st
	c.mu.Unlock()
	db := database.DB.Model(&models.RomItem{}).Where("is_available = ?", true)
	db.Count(&st.Files)
	database.DB.Model(&models.RomItem{}).Where("is_available = ?", true).Select("COALESCE(SUM(size_bytes),0)").Scan(&st.TotalBytes)
	database.DB.Model(&models.RomItem{}).Where("is_available = ? AND cache_status = ?", true, "cached").Count(&st.Cached)
	database.DB.Model(&models.RomItem{}).Where("is_available = ? AND cache_status = ?", true, "cached").Select("COALESCE(SUM(size_bytes),0)").Scan(&st.CachedBytes)
	database.DB.Model(&models.RomItem{}).Where("is_available = ? AND cache_status = ?", true, "error").Count(&st.Errors)
	database.DB.Model(&models.RomItem{}).Where("is_available = ? AND cache_status = ?", true, "skipped").Count(&st.Skipped)
	st.Pending = st.Files - st.Cached - st.Errors - st.Skipped
	if st.Pending < 0 {
		st.Pending = 0
	}
	return st
}

// EnsureSources creates the RomSource of the folder chosen before sources existed (cfg.FolderID).
func EnsureSources() {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if cfg.FolderID == "" {
		return
	}
	var n int64
	database.DB.Model(&models.RomSource{}).Where("folder_id = ?", cfg.FolderID).Count(&n)
	if n == 0 {
		database.DB.Create(&models.RomSource{FolderID: cfg.FolderID, FolderName: cfg.FolderName, FolderPath: cfg.FolderName, Layout: gdrive.LayoutAuto})
	}
}

// ScanSources reads every library folder. A folder mapped by one source is skipped by the
// others (so "roms/Da esposa" can be PS1 while "roms" stays automatic).
func ScanSources(ctx context.Context, svc *gdrive.DriveService, sources []models.RomSource) ([]models.RomItem, error) {
	all := map[string]bool{}
	for _, s := range sources {
		all[s.FolderID] = true
	}
	seen := map[string]bool{}
	var items []models.RomItem
	for _, src := range sources {
		skip := make(map[string]bool, len(all))
		for id := range all {
			if id != src.FolderID {
				skip[id] = true
			}
		}
		got, err := svc.ScanSource(ctx, src.FolderID, gdrive.ScanOptions{Console: src.Console, Layout: src.Layout, Skip: skip, MaxDepth: 6})
		if err != nil {
			return nil, fmt.Errorf("pasta %q: %w", src.FolderName, err)
		}
		for _, it := range got {
			if seen[it.DriveFileID] {
				continue
			}
			seen[it.DriveFileID] = true
			it.SourceID = src.ID
			it.GameKey = strconv.FormatUint(uint64(src.ID), 10) + ":" + it.GameKey
			if src.Console != "" && src.FolderName != "" {
				it.FolderPath = strings.Trim(src.FolderName+"/"+it.FolderPath, "/")
			}
			items = append(items, it)
		}
	}
	return items, nil
}

// SyncFromDrive re-reads the library folders and updates the ROM list.
// Files that disappeared from Drive become unavailable (their SSD copy is removed by the next pass).
func (c *Cache) SyncFromDrive(ctx context.Context) (int, error) {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if cfg.OAuthRefreshToken == "" {
		return 0, fmt.Errorf("Google Drive não conectado")
	}
	EnsureSources()
	var sources []models.RomSource
	database.DB.Order("id").Find(&sources)
	if len(sources) == 0 {
		return 0, fmt.Errorf("nenhuma pasta escolhida")
	}
	c.mu.Lock()
	c.st.Syncing = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.st.Syncing = false
		c.mu.Unlock()
	}()

	items, err := ScanSources(ctx, gdrive.NewDriveService(cfg), sources)
	if err != nil {
		return 0, err
	}
	seen := make(map[string]bool, len(items))
	var total int64
	for _, it := range items {
		seen[it.DriveFileID] = true
		total += it.SizeBytes
		var ex models.RomItem
		if err := database.DB.Unscoped().Where("drive_file_id = ?", it.DriveFileID).First(&ex).Error; err != nil {
			database.DB.Create(&it)
			continue
		}
		changed := ex.SizeBytes != it.SizeBytes || !ex.ModifiedAt.Equal(it.ModifiedAt) || ex.Name != it.Name || ex.Console != it.Console
		ex.DeletedAt = it.DeletedAt
		ex.Name, ex.Console, ex.Extension = it.Name, it.Console, it.Extension
		ex.SizeBytes, ex.SizeFormatted, ex.MimeType = it.SizeBytes, it.SizeFormatted, it.MimeType
		ex.FolderPath, ex.DownloadURL, ex.ModifiedAt = it.FolderPath, it.DownloadURL, it.ModifiedAt
		ex.SourceID, ex.GameKey, ex.GameTitle, ex.GameFolder = it.SourceID, it.GameKey, it.GameTitle, it.GameFolder
		ex.GameParts, ex.GameMain, ex.GamePath = it.GameParts, it.GameMain, it.GamePath
		ex.DirectURL = ""
		ex.IsAvailable = true
		if changed && ex.CacheStatus == "cached" {
			ex.CacheStatus = "" // re-download the new version
		}
		database.DB.Unscoped().Save(&ex)
	}
	// Everything not in the folder anymore (including the old sample entries) is hidden.
	var all []models.RomItem
	database.DB.Where("is_available = ?", true).Find(&all)
	for _, r := range all {
		if !seen[r.DriveFileID] {
			database.DB.Model(&models.RomItem{}).Where("id = ?", r.ID).Update("is_available", false)
		}
	}

	now := time.Now()
	cfg.LastSyncedAt = &now
	cfg.TotalFilesCount = len(items)
	cfg.TotalSizeBytes = total
	cfg.TotalSizeFormatted = gdrive.FormatBytes(total)
	cfg.UpdatedAt = now
	database.DB.Save(&cfg)

	c.mu.Lock()
	c.st.LastSyncAt = &now
	c.st.LastError = ""
	c.mu.Unlock()
	return len(items), nil
}

var unsafeChars = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]+`)

func safe(s string) string {
	s = strings.TrimSpace(unsafeChars.ReplaceAllString(s, "_"))
	if s == "" || s == "." || s == ".." {
		return "_"
	}
	return s
}

func (c *Cache) pathFor(r models.RomItem) string {
	console := r.Console
	if console == "" {
		console = "Outros"
	}
	return filepath.Join(c.dir, safe(console), safe(r.DriveFileID+"_"+r.Name))
}

// LocalFile returns the SSD copy of a ROM when it is complete.
func (c *Cache) LocalFile(r models.RomItem) (string, bool) {
	if r.LocalPath == "" || r.CacheStatus != "cached" {
		return "", false
	}
	fi, err := os.Stat(r.LocalPath)
	if err != nil || fi.IsDir() || (r.SizeBytes > 0 && fi.Size() != r.SizeBytes) {
		return "", false
	}
	return r.LocalPath, true
}

func (c *Cache) pass(ctx context.Context) {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if cfg.OAuthRefreshToken == "" {
		return
	}
	c.mu.Lock()
	if c.st.Running {
		c.mu.Unlock()
		return
	}
	c.st.Running = true
	c.mu.Unlock()
	defer func() {
		now := time.Now()
		c.mu.Lock()
		c.st.Running, c.st.Current, c.st.CurrentBytes, c.st.CurrentTotal = false, "", 0, 0
		c.st.LastPassAt = &now
		c.mu.Unlock()
	}()

	c.gc(c.ownsDir())
	svc := gdrive.NewDriveService(cfg)

	var used int64
	database.DB.Model(&models.RomItem{}).Where("is_available = ? AND cache_status = ?", true, "cached").Select("COALESCE(SUM(size_bytes),0)").Scan(&used)

	var todo []models.RomItem
	// Small files first: the whole library becomes usable sooner.
	database.DB.Where("is_available = ? AND (cache_status IS NULL OR cache_status IN ?)", true, []string{"", "error", "skipped"}).
		Order("size_bytes ASC").Find(&todo)
	for _, r := range todo {
		if ctx.Err() != nil {
			return
		}
		if c.maxBytes > 0 && used+r.SizeBytes > c.maxBytes {
			database.DB.Model(&models.RomItem{}).Where("id = ?", r.ID).Updates(map[string]any{"cache_status": "skipped", "cache_error": "limite ROMS_CACHE_MAX_GB atingido"})
			continue
		}
		dest := c.pathFor(r)
		c.mu.Lock()
		c.st.Current, c.st.CurrentBytes, c.st.CurrentTotal = r.Name, 0, r.SizeBytes
		c.mu.Unlock()
		n, err := svc.DownloadToFile(ctx, r.DriveFileID, dest, func(b int64) {
			c.mu.Lock()
			c.st.CurrentBytes = b
			c.mu.Unlock()
		})
		if err == nil && r.SizeBytes > 0 && n != r.SizeBytes {
			err = fmt.Errorf("tamanho diferente do Drive (%d de %d bytes)", n, r.SizeBytes)
			os.Remove(dest)
		}
		if err != nil {
			database.DB.Model(&models.RomItem{}).Where("id = ?", r.ID).Updates(map[string]any{"cache_status": "error", "cache_error": err.Error()})
			c.setErr(fmt.Errorf("%s: %w", r.Name, err))
			continue
		}
		now := time.Now()
		database.DB.Model(&models.RomItem{}).Where("id = ?", r.ID).Updates(map[string]any{
			"cache_status": "cached", "cache_error": "", "local_path": dest, "cached_at": &now,
		})
		used += n
	}
}

const marker = ".memorycard-roms-cache"

// ownsDir reports whether the cache dir was created by us (marker file), so gc may delete
// unknown files in it. A pre-existing non-empty folder is never swept.
func (c *Cache) ownsDir() bool {
	m := filepath.Join(c.dir, marker)
	if _, err := os.Stat(m); err == nil {
		return true
	}
	entries, err := os.ReadDir(c.dir)
	if err != nil && !os.IsNotExist(err) {
		return false
	}
	if len(entries) > 0 {
		return false
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return false
	}
	return os.WriteFile(m, []byte("Cópia local da biblioteca de ROMs do MemoryCard. Gerenciada pelo servidor.\n"), 0o644) == nil
}

// gc deletes SSD copies of files removed from Drive and, when the folder is ours, stray files.
func (c *Cache) gc(sweep bool) {
	var gone []models.RomItem
	database.DB.Unscoped().Where("(is_available = ? OR deleted_at IS NOT NULL) AND local_path <> ''", false).Find(&gone)
	for _, r := range gone {
		os.Remove(r.LocalPath)
		database.DB.Unscoped().Model(&models.RomItem{}).Where("id = ?", r.ID).Updates(map[string]any{"local_path": "", "cache_status": ""})
	}
	if !sweep {
		return
	}
	keep := map[string]bool{filepath.Clean(filepath.Join(c.dir, marker)): true}
	var live []models.RomItem
	database.DB.Where("local_path <> ''").Find(&live)
	for _, r := range live {
		keep[filepath.Clean(r.LocalPath)] = true
	}
	_ = filepath.Walk(c.dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, ".part") || !keep[filepath.Clean(p)] {
			os.Remove(p)
		}
		return nil
	})
}
