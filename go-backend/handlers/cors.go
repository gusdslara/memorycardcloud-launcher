package handlers

import (
	"os"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

// DefaultCORSOrigins are the origins that may call the private API with credentials:
// the site, local dev servers and the Tauri webview of the app on every OS
// (tauri://localhost on macOS/iOS/Linux, http(s)://tauri.localhost on Windows/Android).
const DefaultCORSOrigins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://localhost:5174,http://localhost:1420," +
	"https://memorycard.cloud,https://www.memorycard.cloud,https://memorycard.digital,https://www.memorycard.digital," +
	"tauri://localhost,http://tauri.localhost,https://tauri.localhost"

// CORSOrigins merges CORS_ORIGINS (extra origins) with the defaults. CORS_ORIGINS used to
// REPLACE the defaults, and the production value listed only the site: the app's webview
// (tauri://localhost, http://tauri.localhost) was blocked, so reviews and the live catalog
// never loaded inside the app.
func CORSOrigins(extra string) string {
	seen := map[string]bool{}
	var out []string
	for _, list := range []string{DefaultCORSOrigins, extra} {
		for _, o := range strings.Split(list, ",") {
			o = strings.TrimRight(strings.TrimSpace(o), "/")
			if o == "" || o == "*" || seen[o] {
				continue
			}
			seen[o] = true
			out = append(out, o)
		}
	}
	return strings.Join(out, ",")
}

// isOpenDataRequest: read-only public data (catalog, ports, reviews) that anyone may use from any site.
func isOpenDataRequest(c *fiber.Ctx) bool {
	method := c.Method()
	if method == fiber.MethodOptions {
		// preflight: only when the real request is a read
		m := strings.ToUpper(c.Get(fiber.HeaderAccessControlRequestMethod))
		if m != fiber.MethodGet && m != fiber.MethodHead {
			return false
		}
	} else if method != fiber.MethodGet && method != fiber.MethodHead {
		return false
	}
	p := c.Path()
	switch {
	case strings.HasPrefix(p, "/api/public"),
		p == "/api/catalog", strings.HasPrefix(p, "/api/catalog/"),
		p == "/api/reviews", p == "/api/reviews/summary",
		p == "/api/ports/community":
		return true
	}
	return false
}

// CORS returns the CORS middleware:
//   - open data (GET of catalog, ports and reviews, everything under /api/public): any origin, no credentials;
//   - the rest of the API: only the known origins (site + app), with credentials.
func CORS() fiber.Handler {
	private := cors.New(cors.Config{
		AllowCredentials: true,
		AllowOrigins:     CORSOrigins(os.Getenv("CORS_ORIGINS")),
		AllowHeaders:     "Origin, Content-Type, Accept, Authorization, access_token, If-None-Match, X-Admin-Token, Upload-Offset",
		ExposeHeaders:    "ETag",
	})
	open := cors.New(cors.Config{
		AllowOrigins:  "*",
		AllowMethods:  "GET,HEAD,OPTIONS",
		AllowHeaders:  "Origin, Content-Type, Accept, If-None-Match",
		ExposeHeaders: "ETag, Link, X-Total-Count",
		MaxAge:        86400,
	})
	return func(c *fiber.Ctx) error {
		if isOpenDataRequest(c) {
			return open(c)
		}
		return private(c)
	}
}
