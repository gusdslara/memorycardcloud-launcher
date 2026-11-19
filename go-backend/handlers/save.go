package handlers

import (
	"fmt"
	"os"

	"go-backend/database"
	"go-backend/internal/backupstore"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// Helper to get user ID from token
func getUserID(c *fiber.Ctx) (uint, error) {
	tokenString := c.Get("Authorization")
	if tokenString == "" {
		return 0, fmt.Errorf("unauthenticated")
	}

	if len(tokenString) > 7 && tokenString[:7] == "Bearer " {
		tokenString = tokenString[7:]
	}

	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(os.Getenv("JWT_SECRET")), nil
	})

	if err != nil || !token.Valid {
		return 0, fmt.Errorf("unauthenticated")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return 0, fmt.Errorf("unauthenticated")
	}
	sub, ok := claims["sub"].(float64)
	if !ok || sub <= 0 {
		return 0, fmt.Errorf("unauthenticated")
	}
	return uint(sub), nil
}

// UploadSave POST /api/saves (site): one save per request, stored by internal/backupstore
// (owner's Google Drive) with the plan quota. Big files use /api/backups/uploads.
func UploadSave(c *fiber.Ctx) error {
	return receiveMultipartBackup(c, "misc")
}

func GetSaves(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}

	saves := backupstore.Default().List(userID)

	// Covers of the user's games
	var games []models.Game
	database.DB.Where("user_id = ?", userID).Find(&games)
	coverMap := make(map[string]string)
	for _, g := range games {
		coverMap[g.Name] = g.CoverURL
	}
	for i := range saves {
		if url, ok := coverMap[saves[i].GameName]; ok {
			saves[i].CoverURL = url
		}
	}

	return c.JSON(saves)
}

func DownloadSave(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}
	save, err := backupstore.Default().Get(userID, c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Save not found"})
	}
	return serveBackup(c, save)
}

func DeleteSave(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}
	if err := backupstore.Default().Delete(userID, c.Params("id")); err != nil {
		if err == backupstore.ErrNotFound {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Save not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Could not delete file"})
	}
	return c.JSON(fiber.Map{"message": "Save deleted successfully"})
}
