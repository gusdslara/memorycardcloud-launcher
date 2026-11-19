package models

import "time"

// Status of a community port submission.
const (
	PortSubmissionPending  = "pending"
	PortSubmissionApproved = "approved"
	PortSubmissionRejected = "rejected"
)

// PortSubmission is a port/recomp sent by a user from the app ("Enviar para aprovação").
// The superadmin reviews it; approved ones are served by GET /api/ports/community and
// merged into the app's catalog (curated ids always win).
type PortSubmission struct {
	ID        uint   `gorm:"primaryKey"`
	UserID    uint   `gorm:"not null;index"`
	UserEmail string `gorm:"size:255"`
	UserName  string `gorm:"size:255"`
	Status    string `gorm:"size:16;not null;default:pending;index"` // pending | approved | rejected

	// Listing / dedupe columns, copied from the normalized payload.
	PortID      string `gorm:"size:80;index"`
	Name        string `gorm:"size:120"`
	ProjectName string `gorm:"size:160;index"`
	Console     string `gorm:"size:60"`
	GithubRepo  string `gorm:"size:160;index"` // owner/repo, lower-case comparisons

	// Payload is the normalized PortItem JSON (whitelisted fields only).
	Payload string `gorm:"type:text;not null"`

	RejectReason    string `gorm:"size:500"`
	ReviewedBy      *uint
	ReviewedByEmail string `gorm:"size:255"`
	ReviewedAt      *time.Time

	CreatedAt time.Time
	UpdatedAt time.Time
}
