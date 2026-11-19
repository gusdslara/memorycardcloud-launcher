package handlers

import (
	"errors"
	"strconv"

	"go-backend/internal/uploads"

	"github.com/gofiber/fiber/v2"
)

// Chunked uploads for the admin page (games and app builds can be several GB).

func AdminStartUpload(c *fiber.Ctx) error {
	var req struct {
		FileName string `json:"file_name"`
		Size     int64  `json:"size"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "JSON inválido"})
	}
	u, err := uploads.Default().Start(adminUserID(c), req.FileName, req.Size)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(u)
}

func AdminUploadStatus(c *fiber.Ctx) error {
	u, err := uploads.Default().Get(adminUserID(c), c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": err.Error()})
	}
	return c.JSON(u)
}

func AdminUploadChunk(c *fiber.Ctx) error {
	offset, err := strconv.ParseInt(c.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Upload-Offset ausente"})
	}
	u, err := uploads.Default().Append(adminUserID(c), c.Params("id"), offset, c.Body())
	switch {
	case errors.Is(err, uploads.ErrNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": err.Error()})
	case errors.Is(err, uploads.ErrOffset):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": err.Error(), "received": u.Received})
	case err != nil:
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	return c.JSON(u)
}
