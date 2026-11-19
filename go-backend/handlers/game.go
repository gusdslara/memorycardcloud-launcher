package handlers

import (
	"fmt"
	"go-backend/database"
	"go-backend/models"
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v2"
)

func UploadCover(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}

	gameName := c.FormValue("game_name")
	if gameName == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Game name required"})
	}

	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "No file uploaded"})
	}

	// Create upload directory: uploads/{userID}/{gameName}/
	baseDir := os.Getenv("DATA_DIR")
	if baseDir == "" {
		baseDir = "./uploads"
	}
	// Structured cover path: /data/users/{id}/covers/{game}/cover.ext
	// Or maybe just alongside saves?
	// User wants "filebrowser" so maybe /data/users/{id}/misc/{game}/cover.ext or similar.
	// Let's stick to /data/users/{id}/covers/{game} to keep it clean but separate from raw saves?
	// Or put it IN the game folder? /data/users/{id}/{platform}/{game}/cover.ext
	// But we don't have platform here. "misc" or "covers"?
	// Let's use "covers" as platform/category placeholder for now, or just "assets".
	// The user likely wants to see the cover next to the save if possible, but without platform it's hard.
	// Let's use strict "assets" folder.
	userDir := fmt.Sprintf("%d", userID)
	uploadDir := filepath.Join(baseDir, "users", userDir, "assets", gameName)

	if err := os.MkdirAll(uploadDir, os.ModePerm); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Could not create upload directory"})
	}

	// Save file as cover.ext (e.g. cover.jpg, cover.png)
	// We want to overwrite existing cover. ideally we check extension.
	ext := filepath.Ext(file.Filename)
	filename := "cover" + ext
	savePath := filepath.Join(uploadDir, filename)

	if err := c.SaveFile(file, savePath); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Could not save file"})
	}

	// Update or Create Game record
	var game models.Game
	result := database.DB.Where("user_id = ? AND name = ?", userID, gameName).First(&game)

	// Since savePath is local "./uploads...", we need to convert to public URL
	// Assuming static file serving is set up for /uploads, or we serve via endpoint.
	// Let's assume standard static serving at root or /uploads/
	// For now, store the path relative to root, and we can prepend base URL in response or frontend.
	// Actually best to return full URL if we know the host, but relative is safer for now.
	// Clean path for URL: replace backslashes with forward slashes
	publicPath := filepath.ToSlash(savePath)

	if result.Error != nil {
		// Create new
		game = models.Game{
			UserID:   userID,
			Name:     gameName,
			CoverURL: publicPath,
		}
		database.DB.Create(&game)
	} else {
		// Update existing
		game.CoverURL = publicPath
		database.DB.Save(&game)
	}

	return c.JSON(fiber.Map{
		"url": publicPath,
	})
}
