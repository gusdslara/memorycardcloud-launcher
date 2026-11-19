package models

import (
	"strings"
	"time"

	"gorm.io/gorm"
)

type Plan struct {
	Tier              string    `gorm:"primaryKey" json:"tier"` // silver, gold, diamond, exclusive, etc.
	Name              string    `json:"name"`
	Description       string    `json:"description"`
	MonthlyPrice      float64   `json:"monthly_price"`
	YearlyPrice       float64   `json:"yearly_price"`
	MonthlyDiscount   int       `json:"monthly_discount"`    // Configurable percentage
	YearlyDiscount    int       `json:"yearly_discount"`     // Configurable percentage
	IsPromoActive     bool      `json:"is_promo_active"`     // If true, plan is free/promo
	PromoEndsAt       *string   `json:"promo_ends_at"`       // ISO date string
	Url               string    `json:"url"`                 // Checkout URL for the plan
	StorageLimitBytes int64     `json:"storage_limit_bytes"` // Storage limit in bytes for game backups
	StorageDisplay    string    `json:"storage_display"`     // e.g. "100 GB", "1 TB"
	HasRomsAccess     bool      `json:"has_roms_access"`     // Special ROMs/ISOs Google Drive access
	IsSecret          bool      `json:"is_secret"`           // Secret tier, hidden from public plans page
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

func (p *Plan) BeforeCreate(tx *gorm.DB) (err error) {
	return
}

// PlanStorageResolver can be registered by database package to query DB without import cycle
var PlanStorageResolver func(tier string) int64

// GetPlanStorageLimit returns the storage limit in bytes for a given plan tier
func GetPlanStorageLimit(tier string) int64 {
	if PlanStorageResolver != nil {
		if limit := PlanStorageResolver(tier); limit > 0 {
			return limit
		}
	}

	const (
		GB = 1024 * 1024 * 1024
		TB = 1024 * GB
	)

	switch strings.ToLower(tier) {
	case "exclusive":
		return 100 * TB
	case "diamond":
		return 100 * GB
	case "gold":
		return 30 * GB
	case "silver":
		return 5 * GB // base plan: 5 GB of cloud saves per user
	default:
		return 100 * 1024 * 1024 // 100 MB default
	}
}
