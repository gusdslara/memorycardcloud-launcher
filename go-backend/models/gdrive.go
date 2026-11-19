package models

import (
	"time"

	"gorm.io/gorm"
)

// GoogleDriveConfig stores credentials and folder configurations for ROMs/ISOs
type GoogleDriveConfig struct {
	ID                 uint       `gorm:"primaryKey" json:"id"`
	FolderID           string     `json:"folder_id"`                          // Google Drive folder ID containing ROMs/ISOs
	FolderURL          string     `json:"folder_url"`                         // Optional convenience URL
	APIKey             string     `json:"api_key"`                            // Google Cloud API key
	ServiceAccountJSON string     `json:"service_account_json"`               // Service account credentials JSON
	AuthType           string     `gorm:"default:'api_key'" json:"auth_type"` // "api_key", "service_account", "public"
	IsActive           bool       `gorm:"default:true" json:"is_active"`
	LastSyncedAt       *time.Time `json:"last_synced_at"`
	TotalFilesCount    int        `json:"total_files_count"`
	TotalSizeBytes     int64      `json:"total_size_bytes"`
	TotalSizeFormatted string     `json:"total_size_formatted"`
	UpdatedAt          time.Time  `json:"updated_at"`

	// Google login of the superadmin (OAuth "oauth" auth type). The refresh token never leaves the server.
	OAuthRefreshToken string     `json:"-"`
	OAuthEmail        string     `json:"oauth_email"`
	OAuthConnectedAt  *time.Time `json:"oauth_connected_at"`
	FolderName        string     `json:"folder_name"` // e.g. "roms"
}

// RomItem represents an individual ROM, ISO, BIOS, or game archive stored in Google Drive
type RomItem struct {
	gorm.Model
	DriveFileID   string    `gorm:"uniqueIndex;not null" json:"drive_file_id"`
	Name          string    `gorm:"not null" json:"name"`
	Console       string    `json:"console"`   // "PS2", "PS1", "Switch", "GameCube", "Wii", "PSP", "N64", "SNES", "GBA", "BIOS", "Retro"
	Extension     string    `json:"extension"` // ".iso", ".chd", ".rvz", ".nsp", ".bin", ".zip", etc.
	SizeBytes     int64     `json:"size_bytes"`
	SizeFormatted string    `json:"size_formatted"` // e.g. "2.4 GB"
	MimeType      string    `json:"mime_type"`
	FolderPath    string    `json:"folder_path"`
	DirectURL     string    `json:"direct_url"`
	DownloadURL   string    `json:"download_url"`
	IsAvailable   bool      `gorm:"default:true" json:"is_available"`
	ModifiedAt    time.Time `json:"modified_at"`

	// Local SSD copy on the server (Google Drive stays the source of truth).
	LocalPath   string     `json:"-"`
	CacheStatus string     `json:"cache_status"` // "" (pending) | cached | error | skipped
	CachedAt    *time.Time `json:"cached_at"`
	CacheError  string     `json:"cache_error,omitempty"`

	// Library folder it came from and the game it belongs to. A game is one loose file, a set of
	// loose files with the same name (Game.cue + Game (Track 1).bin, Disc 1/Disc 2) or a folder
	// with everything of one game (PS1 bin/cue, extracted PS3/Wii U/PC games).
	SourceID   uint   `gorm:"index" json:"source_id"`
	GameKey    string `gorm:"index" json:"game_key"`
	GameTitle  string `json:"game_title"`
	GameFolder bool   `json:"game_folder"` // the game has its own folder
	GameParts  int    `json:"game_parts"`  // files of the game
	GameMain   bool   `json:"game_main"`   // file a launcher opens (.m3u > .cue > image > biggest)
	GamePath   string `json:"game_path"`   // path inside the game folder (or the file name)

	ConsoleDir string `gorm:"-" json:"-"` // scan only: console folder inside the source
	RelDir     string `gorm:"-" json:"-"` // scan only: folder inside the console folder
}

// RomSource is a Google Drive folder of the private library.
// Console "" = automatic (each sub-folder is a console: PS2/, Nintendo 64/…); otherwise every
// file below belongs to that console. Sub-folders mapped by another source are skipped.
type RomSource struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	FolderID   string    `gorm:"uniqueIndex;not null" json:"folder_id"`
	FolderName string    `json:"folder_name"`
	FolderPath string    `json:"folder_path"` // breadcrumb shown in the admin ("Meu Drive / roms / PS1")
	Console    string    `json:"console"`
	Layout     string    `gorm:"default:'auto'" json:"layout"` // auto | loose | folders
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}
