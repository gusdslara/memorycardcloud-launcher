package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gofiber/fiber/v2"
)

// Web ports hospedados em /play/<slug>/ trazem um arquivo _headers (formato Cloudflare Pages / Netlify).
// Quando a landing é servida por este servidor (LANDING_DIR), os mesmos cabeçalhos valem aqui: sem eles
// o God of War (WebAssembly com threads) não tem cross-origin isolation e não roda.
// Só o bloco "/*" de cada _headers é aplicado (os blocos por extensão tratam de Content-Type/Encoding,
// que o Static já resolve).

type playHeaderCache struct {
	mu   sync.Mutex
	byID map[string]map[string]string
}

func parsePlayHeaders(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	inRoot := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inRoot = trimmed == "/*"
			continue
		}
		if !inRoot {
			continue
		}
		k, v, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}

func (c *playHeaderCache) get(landingDir, slug string) map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if h, ok := c.byID[slug]; ok {
		return h
	}
	h := parsePlayHeaders(filepath.Join(landingDir, "play", slug, "_headers"))
	c.byID[slug] = h
	return h
}

// playHeadersMiddleware aplica /play/<slug>/_headers às respostas desse diretório.
func playHeadersMiddleware(landingDir string) fiber.Handler {
	cache := &playHeaderCache{byID: map[string]map[string]string{}}
	return func(c *fiber.Ctx) error {
		rest := strings.TrimPrefix(c.Path(), "/play/")
		slug, _, _ := strings.Cut(rest, "/")
		if slug != "" && slug != "_shell" && !strings.Contains(slug, "..") {
			for k, v := range cache.get(landingDir, slug) {
				c.Set(k, v)
			}
		}
		if strings.HasSuffix(c.Path(), "/_headers") {
			return c.SendStatus(fiber.StatusNotFound)
		}
		return c.Next()
	}
}
