package main

import (
	"context"
	"log"
	"os"
	"strings"

	"go-backend/internal/catalog"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/adaptor"
)

// mountCatalog wires the public catalog service (internal/catalog) into Fiber, and the superadmin
// view of its scraping bots into `admin` (the /api/admin group, already behind Auth + AdminMiddleware).
func mountCatalog(app *fiber.App, admin fiber.Router) {
	disabled := func(reason string) {
		// The admin page still loads and explains why there is nothing to supervise.
		admin.Get("/scrape/status", func(c *fiber.Ctx) error {
			return c.JSON(fiber.Map{"enabled": false, "reason": reason})
		})
		admin.All("/scrape*", func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": reason})
		})
	}
	if strings.EqualFold(os.Getenv("CATALOG_ENABLED"), "false") {
		disabled("O catálogo está desativado neste servidor (CATALOG_ENABLED=false).")
		return
	}
	svc, err := catalog.New(catalog.ConfigFromEnv())
	if err != nil {
		log.Printf("[catalog] disabled: %v", err)
		disabled("O catálogo não carregou: " + err.Error())
		return
	}
	// Admin: scraping bots (status, per-item attempts, re-scrape, run now, build-time report).
	admin.All("/scrape*", adaptor.HTTPHandler(svc.AdminHandler()))
	if !strings.EqualFold(os.Getenv("CATALOG_SCRAPER"), "false") {
		go svc.Run(context.Background())
	}

	// Large files are streamed by Fiber (Range requests supported), never buffered.
	app.Get("/api/catalog/mirror/:id/:platform", func(c *fiber.Ctx) error {
		f, err := svc.MirrorFile(c.Params("id"), c.Params("platform"))
		if err != nil {
			return c.SendStatus(fiber.StatusNotFound)
		}
		if f.Path == "" {
			return c.Redirect(f.RedirectURL, fiber.StatusFound)
		}
		c.Set("Cache-Control", "public, max-age=86400")
		return c.Download(f.Path, f.FileName)
	})
	app.Get("/api/catalog/images/:sha", func(c *fiber.Ctx) error {
		f, err := svc.ImageFile(c.Params("sha"))
		if err != nil {
			return c.SendStatus(fiber.StatusNotFound)
		}
		if err := c.SendFile(f.Path); err != nil {
			return err
		}
		for k, v := range f.Headers() {
			c.Set(k, v)
		}
		return nil
	})
	// JSON endpoints (catalog, items, status, refresh)
	app.All("/api/catalog*", adaptor.HTTPHandler(svc.Handler()))
}

// Force Rebuild for SSE Endpoint
