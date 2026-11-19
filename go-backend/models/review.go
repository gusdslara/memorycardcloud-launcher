package models

import "time"

// Sources of a port review.
const (
	ReviewSourceMemoryCard     = "memorycard"
	ReviewSourceRecompLauncher = "recomplauncher"
	// Quiver Launcher's public catalog API: reports from every system (Android/iOS included).
	ReviewSourceQuiver = "quiver"
)

// PortReview is a player report ("avaliação") of how a catalog port runs.
// Our own users write them (one per user, port and platform); others are
// imported from RecompLauncher's public, anonymous report API.
type PortReview struct {
	ID     uint   `gorm:"primaryKey" json:"id"`
	PortID string `gorm:"not null;index;uniqueIndex:idx_review_user_port_platform;uniqueIndex:idx_review_external" json:"-"`
	Source string `gorm:"not null;index" json:"source"` // memorycard | recomplauncher | quiver
	// ExternalKey identifies an imported report: sha1(source|rlId|when|specs|version).
	// Nil for our own reviews. Unique per port (one report may feed several ports).
	ExternalKey *string `gorm:"uniqueIndex:idx_review_external" json:"-"`
	// UserID is the author of our own reviews (nil for imported ones). Never exposed.
	UserID   *uint  `gorm:"index;uniqueIndex:idx_review_user_port_platform" json:"-"`
	Author   string `json:"author"`
	Hardware string `gorm:"size:300" json:"hardware"`
	Platform string `gorm:"uniqueIndex:idx_review_user_port_platform" json:"platform"` // windows | linux | macos | android | ios | ""
	Version  string `json:"version"`
	Rating   *int   `json:"rating"`  // 1–5, nil for imported reports
	Verdict  string `json:"verdict"` // runs | issues | broken
	FPS      *int   `json:"fps"`
	Stutter  *bool  `json:"stutter"`
	Note     string `gorm:"size:500" json:"note"`
	// Hidden removes an imported report from listings without deleting it,
	// so the importer does not bring it back.
	Hidden    bool      `gorm:"not null;default:false;index" json:"-"`
	CreatedAt time.Time `json:"createdAt"` // for imported reports: the report's own date
	UpdatedAt time.Time `json:"-"`
}

// ReviewImportState remembers, per external app, how many reports the source
// had the last time we imported it, so unchanged apps are not fetched again.
type ReviewImportState struct {
	ID         uint   `gorm:"primaryKey"`
	Source     string `gorm:"not null;uniqueIndex:idx_review_import_src_ext"`
	ExternalID string `gorm:"not null;uniqueIndex:idx_review_import_src_ext"`
	Total      int    `gorm:"not null;default:0"`
	CheckedAt  time.Time
}
