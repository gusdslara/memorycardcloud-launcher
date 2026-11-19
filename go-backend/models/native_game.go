package models

import "time"

// NativeGame is a game the superadmin uploads (abandonware / native builds), listed in
// the "Jogos" tab of the site and the app under each platform.
type NativeGame struct {
	ID          uint          `gorm:"primaryKey" json:"-"`
	Slug        string        `gorm:"uniqueIndex;not null" json:"id"`
	Title       string        `gorm:"not null" json:"title"`
	Developer   string        `json:"developer,omitempty"`
	Publisher   string        `json:"publisher,omitempty"`
	Year        int           `json:"year,omitempty"`
	Genre       string        `json:"genre,omitempty"`
	Description string        `json:"description,omitempty"`
	CoverFile   string        `json:"-"`
	CoverURL    string        `gorm:"-" json:"cover_url,omitempty"`
	Published   bool          `gorm:"default:true" json:"published"`
	Builds      []NativeBuild `gorm:"foreignKey:GameID;constraint:OnDelete:CASCADE" json:"builds"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
}

// NativeBuild is one platform's package of a NativeGame (one per platform).
type NativeBuild struct {
	ID          uint      `gorm:"primaryKey" json:"-"`
	GameID      uint      `gorm:"uniqueIndex:idx_game_platform" json:"-"`
	Platform    string    `gorm:"uniqueIndex:idx_game_platform" json:"platform"` // windows | linux | macos | android | ios
	Kind        string    `json:"kind"`                                          // zip | exe | apk | apk+data | split-apk
	FileName    string    `json:"file_name"`                                     // name the visitor downloads
	StoredFile  string    `json:"-"`
	Size        int64     `json:"size"`
	SHA256      string    `json:"sha256"`
	Version     string    `json:"version,omitempty"`
	Executable  string    `json:"executable,omitempty"`
	Executables []string  `gorm:"serializer:json" json:"executables,omitempty"`
	PackageName string    `json:"package_name,omitempty"`
	ApkFile     string    `json:"-"`
	DataFile    string    `json:"-"`
	DataSize    int64     `json:"data_size,omitempty"`
	ObbFiles    []string  `gorm:"serializer:json" json:"obb_files,omitempty"`
	Notes       []string  `gorm:"serializer:json" json:"notes,omitempty"`
	CreatedAt   time.Time `json:"created_at"`

	// Filled by the API
	DownloadURL string `gorm:"-" json:"download_url"`
	ApkURL      string `gorm:"-" json:"apk_url,omitempty"`
	DataURL     string `gorm:"-" json:"data_url,omitempty"`
}

// AppRelease is one build of the MemoryCard app itself (installer or updater bundle).
type AppRelease struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Platform  string    `gorm:"index" json:"platform"` // windows | linux | macos | android
	Arch      string    `json:"arch"`                  // x86_64 | aarch64 | universal
	Version   string    `json:"version"`               // semver, e.g. 0.2.0
	Build     int       `gorm:"index" json:"build"`    // increasing build number
	Role      string    `json:"role"`                  // installer | updater | both
	FileName  string    `json:"file_name"`
	Stored    string    `json:"-"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	Signature string    `json:"-"` // minisign signature (.sig) for the Tauri updater
	Notes     string    `json:"notes,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	HasSig    bool      `gorm:"-" json:"has_signature"`
}
