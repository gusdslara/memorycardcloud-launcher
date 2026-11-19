package models

import "gorm.io/gorm"

type GameSave struct {
	gorm.Model
	UserID    uint                   `json:"user_id"`
	GameName  string                 `json:"game_name"`
	Platform  string                 `json:"platform"`
	Filename  string                 `json:"filename"`                        // Path to the stored file
	Hash      string                 `json:"hash"`                            // SHA-256 hash of the content
	Timestamp int64                  `json:"timestamp"`                       // Unix timestamp
	Size      int64                  `json:"size"`                            // Size in bytes
	Metadata  map[string]interface{} `json:"metadata" gorm:"serializer:json"` // Flexible Document Data (SQLite JSON)
	CoverURL  string                 `json:"cover_url" gorm:"-"`              // Virtual field, populated from Game model

	// Cloud storage (Google Drive of the owner or local disk). BlobID 0 = legacy file at Filename.
	BlobID   uint   `gorm:"index" json:"-"`
	Kind     string `gorm:"default:'save'" json:"kind"` // save | game
	FileName string `json:"file_name"`                  // original name sent by the user
	Status   string `gorm:"-" json:"status"`            // queued | stored (filled from the blob)
}
