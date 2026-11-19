package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestPlayHeadersApplyRootBlock(t *testing.T) {
	// t.TempDir falha no Windows: o Static do Fiber mantém o arquivo aberto; limpeza é best-effort
	dir, err := os.MkdirTemp("", "playheaders")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	game := filepath.Join(dir, "play", "gow-coo")
	if err := os.MkdirAll(game, 0o755); err != nil {
		t.Fatal(err)
	}
	headers := "# comentário\n/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n\n/*.wasm\n  Content-Type: application/wasm\n"
	if err := os.WriteFile(filepath.Join(game, "_headers"), []byte(headers), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(game, "index.html"), []byte("<p>ok</p>"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := fiber.New()
	app.Use("/play", playHeadersMiddleware(dir))
	app.Static("/", dir)

	res, err := app.Test(httptest.NewRequest("GET", "/play/gow-coo/index.html", nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Header.Get("Cross-Origin-Embedder-Policy"); got != "require-corp" {
		t.Fatalf("COEP = %q", got)
	}
	if got := res.Header.Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
		t.Fatalf("COOP = %q", got)
	}
	if got := res.Header.Get("Content-Type"); got == "application/wasm" {
		t.Fatalf("bloco /*.wasm não devia valer para .html")
	}

	res, _ = app.Test(httptest.NewRequest("GET", "/play/gow-coo/_headers", nil))
	if res.StatusCode != 404 {
		t.Fatalf("_headers não deve ser servido, status %d", res.StatusCode)
	}
	res, _ = app.Test(httptest.NewRequest("GET", "/play/sm64/index.html", nil))
	if res.Header.Get("Cross-Origin-Embedder-Policy") != "" {
		t.Fatalf("diretório sem _headers não deve receber COEP")
	}
}
