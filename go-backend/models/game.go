package models

import "gorm.io/gorm"

type Game struct {
	gorm.Model
	UserID   uint   `json:"user_id" gorm:"index:idx_user_game,unique"`
	Name     string `json:"name" gorm:"index:idx_user_game,unique"` // Game Name unique per user
	CoverURL string `json:"cover_url"`
}
