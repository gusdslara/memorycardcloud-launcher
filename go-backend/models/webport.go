package models

import (
	"time"

	"gorm.io/gorm"
)

// WebPortConfig stores global visibility and mode settings for web ports
type WebPortConfig struct {
	ID             uint      `gorm:"primaryKey" json:"id"`
	VisibilityMode string    `gorm:"default:'restricted'" json:"visibility_mode"` // "public" or "restricted"
	AllowGuestDemo bool      `gorm:"default:true" json:"allow_guest_demo"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// WebPortWhitelist defines user emails authorized to access the self-hosted ports when restricted
type WebPortWhitelist struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Email     string    `gorm:"uniqueIndex;not null" json:"email"`
	Notes     string    `json:"notes"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

// WebPortItem represents an online web port in the catalog
type WebPortItem struct {
	gorm.Model
	Slug             string `gorm:"uniqueIndex;not null" json:"slug"`
	Title            string `gorm:"not null" json:"title"`
	Platform         string `json:"platform"`          // e.g. "PS2 / PC", "Nintendo 64", "Switch"
	Engine           string `json:"engine"`            // e.g. "WebAssembly + WebGL", "Emscripten"
	Category         string `json:"category"`          // e.g. "Corrida", "Ação", "RPG", "FPS", "Retro"
	Description      string `json:"description"`
	CoverURL         string `json:"cover_url"`
	SelfHostedURL    string `json:"self_hosted_url"`
	PublicMirrorURL  string `json:"public_mirror_url"`
	RequiredRom      string `json:"required_rom"`      // Exact ROM/ISO name needed
	Region           string `json:"region"`            // e.g. "USA (NTSC-U)", "Global"
	Extensions       string `json:"extensions"`        // e.g. ".iso, .bin/.cue, .z64"
	RequiresKeys     bool   `json:"requires_keys"`     // true for Switch or consoles needing BIOS
	KeysDescription  string `json:"keys_description"`  // e.g. "prod.keys & title.keys ou SCPH-39001.bin"
	CompilationGuide string `json:"compilation_guide"` // Shell commands / instructions
	ServerDirectory  string `json:"server_directory"`  // e.g. "/var/www/memorycard-ports/nfsu2/"
	Status           string `json:"status"`            // "ready", "compiling", "requires_assets"
	IsPublicPreview  bool   `json:"is_public_preview"` // shown in preview when mode is restricted
	IsActive         bool   `gorm:"default:true" json:"is_active"`
}
