package handlers

import (
	"bufio"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/valyala/fasthttp"
)

// StreamEvents handles the SSE endpoint
func StreamEvents(c *fiber.Ctx) error {
	// 1. Auth via Query Param (EventSource doesn't support headers)
	tokenString := c.Query("token")
	if tokenString == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Missing token"})
	}

	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(os.Getenv("JWT_SECRET")), nil
	})

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Invalid token"})
	}

	claims := token.Claims.(jwt.MapClaims)
	userIDFloat, ok := claims["sub"].(float64)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Invalid token claims"})
	}
	userID := uint(userIDFloat)

	// 2. Set SSE Headers
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("Transfer-Encoding", "chunked")

	// 3. Establish Stream
	c.Context().SetBodyStreamWriter(fasthttp.StreamWriter(func(w *bufio.Writer) {
		// Keep-alive loop?
		// Actually Fiber's SetBodyStreamWriter takes over the connection.
		// We need to register this connection to our Hub.

		// For this simple implementation, we can't easily pass the 'w' around to the Hub
		// unless we architect it differently.
		// Instead, we will make a channel for this specific connection.

		msgChan := make(chan string)

		// We need a wrapper to register the channel, not the ctx
		// Let's modify Hub to use channels
		registerChannel(userID, msgChan)
		defer unregisterChannel(userID, msgChan)

		// Send initial retry info
		fmt.Fprintf(w, "retry: 10000\n\n")
		w.Flush()

		// Heartbeat ticker
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case msg := <-msgChan:
				fmt.Fprintf(w, "data: %s\n\n", msg)
				w.Flush()
			case <-ticker.C:
				fmt.Fprintf(w, ": heartbeat\n\n")
				w.Flush()
			}
		}
	}))

	return nil
}

// --- Simplified Hub using Channels ---

type ChannelHub struct {
	clients map[uint]map[chan string]bool
	lock    sync.RWMutex
}

var ChanHub = ChannelHub{
	clients: make(map[uint]map[chan string]bool),
}

func registerChannel(userID uint, ch chan string) {
	ChanHub.lock.Lock()
	defer ChanHub.lock.Unlock()

	if _, ok := ChanHub.clients[userID]; !ok {
		ChanHub.clients[userID] = make(map[chan string]bool)
	}
	ChanHub.clients[userID][ch] = true
}

func unregisterChannel(userID uint, ch chan string) {
	ChanHub.lock.Lock()
	defer ChanHub.lock.Unlock()

	if clients, ok := ChanHub.clients[userID]; ok {
		delete(clients, ch)
		if len(clients) == 0 {
			delete(ChanHub.clients, userID)
		}
	}
	close(ch)
}

func BroadcastUpdate(userID uint) {
	ChanHub.lock.RLock()
	defer ChanHub.lock.RUnlock()

	if clients, ok := ChanHub.clients[userID]; ok {
		for ch := range clients {
			// Non-blocking send to avoid blocking if a client is slow
			select {
			case ch <- "update":
			default:
			}
		}
	}
}
