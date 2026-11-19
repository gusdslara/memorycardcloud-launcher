package handlers

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

// PendingInstallItem representa a intenção de instalação de um jogo/port/emulador gravada
// pelo usuário através do site no nosso domínio.
type PendingInstallItem struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Timestamp int64     `json:"timestamp"`
	CreatedAt time.Time `json:"-"`
}

var (
	pendingLock  sync.RWMutex
	pendingStore = make(map[string]PendingInstallItem)
)

const pendingTTL = 2 * time.Hour

func cleanupExpiredPending() {
	now := time.Now()
	for ip, item := range pendingStore {
		if now.Sub(item.CreatedAt) > pendingTTL {
			delete(pendingStore, ip)
		}
	}
}

// SavePendingInstall salva a intenção de instalação do jogo/port pelo IP do visitante.
// POST /api/app/pending-install
func SavePendingInstall(c *fiber.Ctx) error {
	var body struct {
		Kind      string `json:"kind"`
		ID        string `json:"id"`
		Name      string `json:"name"`
		Timestamp int64  `json:"timestamp"`
	}

	if err := c.BodyParser(&body); err != nil || body.ID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "Requisição inválida. É necessário fornecer kind e id.",
		})
	}

	if body.Kind == "" {
		body.Kind = "port"
	}

	clientIP := c.IP()
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		clientIP = xff
	}

	item := PendingInstallItem{
		Kind:      body.Kind,
		ID:        body.ID,
		Name:      body.Name,
		Timestamp: body.Timestamp,
		CreatedAt: time.Now(),
	}

	pendingLock.Lock()
	cleanupExpiredPending()
	pendingStore[clientIP] = item
	pendingLock.Unlock()

	return c.JSON(fiber.Map{
		"ok":   true,
		"item": item,
	})
}

// GetPendingInstall retorna a intenção de instalação pendente gravada para o IP que fez a requisição.
// GET /api/app/pending-install
func GetPendingInstall(c *fiber.Ctx) error {
	clientIP := c.IP()
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		clientIP = xff
	}

	pendingLock.RLock()
	item, ok := pendingStore[clientIP]
	pendingLock.RUnlock()

	if !ok || time.Since(item.CreatedAt) > pendingTTL {
		return c.SendStatus(fiber.StatusNoContent)
	}

	return c.JSON(item)
}

// ClearPendingInstall remove a intenção de instalação pendente depois que o app já processou.
// DELETE /api/app/pending-install
func ClearPendingInstall(c *fiber.Ctx) error {
	clientIP := c.IP()
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		clientIP = xff
	}

	pendingLock.Lock()
	delete(pendingStore, clientIP)
	pendingLock.Unlock()

	return c.JSON(fiber.Map{"ok": true})
}
