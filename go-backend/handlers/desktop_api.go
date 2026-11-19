package handlers

import (
	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

type CheckVersionRequest struct {
	GameName  string `json:"game_name"`
	Hash      string `json:"hash"`
	Filename  string `json:"filename"`
	Timestamp int64  `json:"timestamp"`
}

type CheckVersionResponse struct {
	ShouldUpload bool   `json:"should_upload"`
	Reason       string `json:"reason,omitempty"`
}

func CheckVersion(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}

	var req CheckVersionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid request"})
	}

	// Check if this specific file HASH exists for this user (deduplication)
	var existingSave models.GameSave
	err = database.DB.Where("user_id = ? AND hash = ?", userID, req.Hash).First(&existingSave).Error

	if err == nil {
		// File found
		return c.JSON(CheckVersionResponse{
			ShouldUpload: false,
			Reason:       "File already exists",
		})
	}

	// Not found, should upload
	return c.JSON(CheckVersionResponse{
		ShouldUpload: true,
		Reason:       "New version",
	})
}

// UploadBackup POST /api/upload/backup (app, single request): stored by internal/backupstore on
// the owner's Google Drive with the plan quota. New app versions use /api/backups/uploads
// (resumable, quota reserved before the first byte).
func UploadBackup(c *fiber.Ctx) error {
	return receiveMultipartBackup(c, "PC")
}
