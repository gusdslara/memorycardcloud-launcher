package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeUpstream simulates GitHub (API + HTML), Wikipedia, a project website and the files themselves.
type fakeUpstream struct {
	srv         *httptest.Server
	mu          sync.Mutex
	tag         string
	rateLimited bool
	apiCalls    atomic.Int64
	api304      atomic.Int64
	fileCalls   map[string]*atomic.Int64
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{tag: "v1.0.0", fileCalls: map[string]*atomic.Int64{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/repos/acme/game/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		f.apiCalls.Add(1)
		f.mu.Lock()
		tag, limited := f.tag, f.rateLimited
		f.mu.Unlock()
		if limited {
			http.Error(w, "rate limited", http.StatusForbidden)
			return
		}
		etag := `"` + tag + `"`
		if r.Header.Get("If-None-Match") == etag {
			f.api304.Add(1)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag,
			"html_url": f.srv.URL + "/web/acme/game/releases/tag/" + tag,
			"assets": []map[string]any{
				{"name": "Game-" + tag + "-Windows.zip", "browser_download_url": f.srv.URL + "/files/Game-" + tag + "-Windows.zip", "size": 10},
				{"name": "Game-" + tag + "-Windows.zip.sig", "browser_download_url": f.srv.URL + "/files/sig", "size": 1},
				{"name": "Game-" + tag + "-Linux.AppImage", "browser_download_url": f.srv.URL + "/files/Game-" + tag + "-Linux.AppImage", "size": 12},
			},
		})
	})
	// HTML fallback
	mux.HandleFunc("/web/acme/game/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		tag := f.tag
		f.mu.Unlock()
		w.Header().Set("Location", f.srv.URL+"/web/acme/game/releases/tag/"+tag)
		w.WriteHeader(http.StatusFound)
	})
	mux.HandleFunc("/web/acme/game/releases/expanded_assets/", func(w http.ResponseWriter, r *http.Request) {
		tag := strings.TrimPrefix(r.URL.Path, "/web/acme/game/releases/expanded_assets/")
		fmt.Fprintf(w, `<a href="/acme/game/releases/download/%[1]s/Game-%[1]s-Windows.zip">x</a><a href="/acme/game/releases/download/%[1]s/Game-%[1]s-Linux.AppImage">y</a>`, tag)
	})
	mux.HandleFunc("/acme/game/releases/download/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/files/"+r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], http.StatusFound)
	})
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/files/")
		f.mu.Lock()
		c := f.fileCalls[name]
		if c == nil {
			c = &atomic.Int64{}
			f.fileCalls[name] = c
		}
		f.mu.Unlock()
		c.Add(1)
		if strings.HasPrefix(name, "static-") {
			io.WriteString(w, "same-bytes") // identical content for two different URLs → must be stored once
			return
		}
		io.WriteString(w, "binary:"+name)
	})
	mux.HandleFunc("/wiki/page/summary/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"type": "standard", "originalimage": map[string]any{"source": f.srv.URL + "/img/cover.png", "width": 600}})
	})
	mux.HandleFunc("/web/acme.png", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/img/logo.png", http.StatusFound)
	})
	mux.HandleFunc("/site/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/img/emu.png"></head></html>`)
	})
	mux.HandleFunc("/img/", func(w http.ResponseWriter, r *http.Request) {
		etag := `"img-` + r.URL.Path + `"`
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Type", "image/png")
		io.WriteString(w, "PNG:"+r.URL.Path)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeUpstream) calls(name string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.fileCalls[name]; c != nil {
		return c.Load()
	}
	return 0
}

func testService(t *testing.T, f *fakeUpstream) *Service {
	t.Helper()
	dir := t.TempDir()
	cat := map[string]any{
		"schemaVersion": 1,
		"ports": []map[string]any{{
			"kind": "port", "id": "game-port", "name": "Game Port", "projectName": "Some Game", "console": "PC / Retro", "author": "acme",
			"githubRepo": "acme/game", "supportedOs": []string{"windows", "linux"}, "downloadUrls": map[string]string{},
			"release": map[string]any{"provider": "github", "repo": "acme/game", "assets": map[string]string{"windows": "-Windows\\.zip$", "linux": "\\.AppImage$"}},
			"art":     map[string]any{"cover": f.srv.URL + "/img/boxart.png", "coverFit": "cover"},
		}},
		"emulators": []map[string]any{
			{
				"kind": "emulator", "id": "emu-a", "name": "Emu A", "system": "Multi-System", "author": "x", "websiteUrl": f.srv.URL + "/site/",
				"supportedOs": []string{"windows"}, "downloadUrls": map[string]string{"windows": f.srv.URL + "/files/static-a.7z"},
			},
			{
				"kind": "emulator", "id": "emu-b", "name": "Emu B", "system": "Multi-System", "author": "x",
				"art":         map[string]any{"logo": f.srv.URL + "/img/emu-b.png"},
				"supportedOs": []string{"windows"}, "downloadUrls": map[string]string{"windows": f.srv.URL + "/files/static-b.7z"},
			},
		},
		"emulatorPicks": map[string]any{}, "systemOrder": []string{},
	}
	b, _ := json.Marshal(cat)
	catPath := filepath.Join(dir, "catalog.json")
	os.WriteFile(catPath, b, 0o644)

	cfg := Config{
		DataDir: filepath.Join(dir, "data"), CatalogPath: catPath, PublicBaseURL: "https://api.example",
		UserAgent: "test", MinInterval: time.Hour, MaxInterval: 8 * time.Hour, RetryBase: time.Minute,
		ImageInterval: 24 * time.Hour, Mirror: true, MirrorPlatform: map[string]bool{"windows": true, "linux": true},
		MaxMirrorBytes: 1 << 20, MaxImageBytes: 1 << 20, Concurrency: 2,
		GitHubAPI: f.srv.URL + "/api", GitHubWeb: f.srv.URL + "/web", WikipediaAPI: f.srv.URL + "/wiki",
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func getCatalog(t *testing.T, s *Service) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/catalog", nil))
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	return out
}

func livePlatformOf(t *testing.T, s *Service, group, id, platform string) map[string]any {
	for _, raw := range getCatalog(t, s)[group].([]any) {
		it := raw.(map[string]any)
		if it["id"] == id {
			p, _ := it["live"].(map[string]any)["platforms"].(map[string]any)[platform].(map[string]any)
			return p
		}
	}
	t.Fatalf("%s not found", id)
	return nil
}

func TestRefreshMirrorsOnceAndUsesETag(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	ctx := context.Background()

	st, err := s.Refresh(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.SourcesChecked != 1 {
		t.Fatalf("one repo → one request, got %d sources", st.SourcesChecked)
	}
	win := livePlatformOf(t, s, "ports", "game-port", "windows")
	if win["version"] != "v1.0.0" || win["assetName"] != "Game-v1.0.0-Windows.zip" {
		t.Fatalf("unexpected resolve: %+v", win)
	}
	if win["mirrorUrl"] != "https://api.example/api/catalog/mirror/game-port/windows" || win["officialUrl"] == "" {
		t.Fatalf("mirror/official missing: %+v", win)
	}
	if f.calls("Game-v1.0.0-Windows.zip") != 1 || f.calls("sig") != 0 {
		t.Fatalf("file downloads: zip=%d sig=%d", f.calls("Game-v1.0.0-Windows.zip"), f.calls("sig"))
	}

	// Second forced run: API answers 304, nothing is downloaded again.
	st2, _ := s.Refresh(ctx, true)
	if st2.NotModified != 1 || st2.Mirrored != 0 {
		t.Fatalf("expected 304 and no new mirror, got %+v", st2)
	}
	if f.calls("Game-v1.0.0-Windows.zip") != 1 {
		t.Fatal("binary was downloaded twice")
	}

	// Not forced and not due: zero upstream requests.
	before := f.apiCalls.Load()
	s.Refresh(ctx, false)
	if f.apiCalls.Load() != before {
		t.Fatal("source checked before it was due")
	}
}

func TestNewReleaseKeepsPreviousAndGCsOlder(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	ctx := context.Background()
	s.Refresh(ctx, true)
	sha1 := livePlatformOf(t, s, "ports", "game-port", "windows")["sha256"].(string)

	f.mu.Lock()
	f.tag = "v1.1.0"
	f.mu.Unlock()
	st, _ := s.Refresh(ctx, true)
	if st.SourcesChanged != 1 || st.Mirrored != 2 {
		t.Fatalf("expected change + 2 new mirrors (win+linux), got %+v", st)
	}
	if !s.blobs.has(sha1) {
		t.Fatal("previous version should be kept for one cycle")
	}

	f.mu.Lock()
	f.tag = "v1.2.0"
	f.mu.Unlock()
	s.Refresh(ctx, true)
	if s.blobs.has(sha1) {
		t.Fatal("version two releases old should be garbage-collected")
	}
	if got := livePlatformOf(t, s, "ports", "game-port", "linux")["version"]; got != "v1.2.0" {
		t.Fatalf("linux not updated: %v", got)
	}
}

func TestRateLimitFallsBackToHTML(t *testing.T) {
	f := newFakeUpstream(t)
	f.rateLimited = true
	s := testService(t, f)
	st, _ := s.Refresh(context.Background(), true)
	if st.Errors != 0 {
		t.Fatalf("html fallback should succeed: %+v %+v", st, s.Status().Problems)
	}
	win := livePlatformOf(t, s, "ports", "game-port", "windows")
	if win["assetName"] != "Game-v1.0.0-Windows.zip" || !strings.Contains(win["officialUrl"].(string), "/releases/download/") {
		t.Fatalf("unexpected: %+v", win)
	}
	// same tag on the next forced run: only the cheap redirect check happens
	st2, _ := s.Refresh(context.Background(), true)
	if st2.NotModified != 1 {
		t.Fatalf("expected not-modified via tag compare: %+v", st2)
	}
}

func TestDedupeImagesAndEndpoints(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.Refresh(context.Background(), true)

	a := livePlatformOf(t, s, "emulators", "emu-a", "windows")
	b := livePlatformOf(t, s, "emulators", "emu-b", "windows")
	if a["sha256"] == nil || a["sha256"] != b["sha256"] {
		t.Fatalf("identical files must share one blob: %v vs %v", a["sha256"], b["sha256"])
	}

	cat := getCatalog(t, s)
	emuA := cat["emulators"].([]any)[0].(map[string]any)["live"].(map[string]any)["images"].(map[string]any)
	port := cat["ports"].([]any)[0].(map[string]any)["live"].(map[string]any)["images"].(map[string]any)
	if emuA["logo"] == nil || port["cover"] == nil || port["logo"] == nil {
		t.Fatalf("images missing: emu=%v port=%v", emuA, port)
	}
	if s.state.Images[imageKey("emu-a", "logo")].Source != "website" {
		t.Fatalf("emulator logo should come from the site's apple-touch-icon, got %s", s.state.Images[imageKey("emu-a", "logo")].Source)
	}

	// image endpoint
	sha := emuA["logo"].(string)[strings.LastIndex(emuA["logo"].(string), "/")+1:]
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/catalog/images/"+sha, nil))
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("image endpoint: %d %v", rec.Code, rec.Header())
	}
	// mirror endpoint serves the stored file
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/catalog/mirror/game-port/windows", nil))
	if rec.Code != 200 || rec.Body.String() != "binary:Game-v1.0.0-Windows.zip" {
		t.Fatalf("mirror endpoint: %d %q", rec.Code, rec.Body.String())
	}
	// ETag on the catalog
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/catalog", nil))
	req := httptest.NewRequest("GET", "/api/catalog", nil)
	req.Header.Set("If-None-Match", rec.Header().Get("ETag"))
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("expected 304, got %d", rec2.Code)
	}
	// image revalidation is a 304 next month, not a re-download
	s.mu.Lock()
	for _, img := range s.state.Images {
		img.NextCheckAt = time.Now().Add(-time.Minute)
	}
	s.mu.Unlock()
	s.Refresh(context.Background(), false)
	if s.state.Images[imageKey("emu-a", "logo")].SHA256 == "" {
		t.Fatal("image lost after revalidation")
	}
}

func TestStatePersistsAcrossRestarts(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.Refresh(context.Background(), true)
	calls := f.apiCalls.Load()

	s2, err := New(s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := livePlatformOf(t, s2, "ports", "game-port", "windows")["mirrorUrl"]; got == nil {
		t.Fatal("restart lost the mirror")
	}
	s2.Refresh(context.Background(), false)
	if f.apiCalls.Load() != calls {
		t.Fatal("restart must not re-scrape sources that are not due")
	}
}

func TestMirrorRedirectsWhenNotStored(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.cfg.Mirror = false
	s.Refresh(context.Background(), true)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/catalog/mirror/game-port/windows", nil))
	if rec.Code != http.StatusFound || !strings.Contains(rec.Header().Get("Location"), "/files/Game-v1.0.0-Windows.zip") {
		t.Fatalf("expected redirect to official file, got %d %s", rec.Code, rec.Header().Get("Location"))
	}
}

func TestAdminRefreshNeedsToken(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/api/catalog/refresh", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", rec.Code)
	}
	s.cfg.AdminToken = "secret"
	req := httptest.NewRequest("POST", "/api/catalog/refresh", nil)
	req.Header.Set("X-Admin-Token", "secret")
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}
}

func TestNextInterval(t *testing.T) {
	cfg := Config{MinInterval: 6 * time.Hour, MaxInterval: 48 * time.Hour, RetryBase: time.Hour}
	if d := nextInterval(cfg, 0, false, 0); d != 6*time.Hour {
		t.Fatal(d)
	}
	if d := nextInterval(cfg, 6*time.Hour, false, 0); d != 12*time.Hour {
		t.Fatal(d)
	}
	if d := nextInterval(cfg, 40*time.Hour, false, 0); d != 48*time.Hour {
		t.Fatal(d)
	}
	if d := nextInterval(cfg, 48*time.Hour, true, 0); d != 6*time.Hour {
		t.Fatal(d)
	}
	if d := nextInterval(cfg, 0, false, 3); d != 4*time.Hour {
		t.Fatal(d)
	}
	if d := nextInterval(cfg, 0, false, 20); d != 24*time.Hour {
		t.Fatal(d)
	}
}

func TestPickAssetParityWithFrontend(t *testing.T) {
	names := []Asset{{Name: "xemu-0.8.139-dbg-windows-x86_64.zip"}, {Name: "xemu-0.8.139-windows-x86_64-pdb.zip"}, {Name: "xemu-0.8.139-windows-x86_64.zip"}}
	if a, _ := PickAsset(names, `xemu-[\d.]+-windows-x86_64\.zip$`); a.Name != "xemu-0.8.139-windows-x86_64.zip" {
		t.Fatal(a.Name)
	}
	goal := []Asset{{Name: "OpenGOAL-Launcher_2.11.2_x64_en-US.msi.zip"}, {Name: "OpenGOAL-Launcher_2.11.2_x64_en-US.msi"}}
	if a, _ := PickAsset(goal, `_x64_en-US\.msi$`); a.Name != "OpenGOAL-Launcher_2.11.2_x64_en-US.msi" {
		t.Fatal(a.Name)
	}
	if _, ok := PickAsset(goal, `([`); ok {
		t.Fatal("invalid regex must not match")
	}
}

func TestPickIcon(t *testing.T) {
	base, _ := url.Parse("https://emu.example/sub/")
	html := `<link rel="icon" href="/favicon.ico"><link rel="icon" sizes="32x32" href="a.png"><link rel="apple-touch-icon" href="/apple.png">`
	if got := pickIcon(html, base); got != "https://emu.example/apple.png" {
		t.Fatal(got)
	}
	if got := pickIcon(`<meta property="og:image" content="https://cdn/x.png">`, base); got != "https://cdn/x.png" {
		t.Fatal(got)
	}
}

func TestEmbeddedCatalogIsValid(t *testing.T) {
	c, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Items) < 40 {
		t.Fatalf("embedded catalog too small: %d", len(c.Items))
	}
	srcs := c.Sources()
	if len(srcs) == 0 || len(srcs) >= len(c.Items)*5 {
		t.Fatalf("unexpected source count %d", len(srcs))
	}
	for _, it := range c.Items {
		if it.Release == nil {
			continue
		}
		for p, pat := range it.Release.Assets {
			if _, err := compileCheck(pat); err != nil {
				t.Errorf("%s/%s: pattern %q does not compile in Go RE2: %v", it.ID, p, pat, err)
			}
		}
	}
}

func compileCheck(p string) (bool, error) {
	_, ok := PickAsset([]Asset{{Name: "x"}}, p)
	if _, err := regexpCompile("(?i)" + p); err != nil {
		return false, err
	}
	return ok, nil
}

var regexpCompile = regexp.Compile

func TestCuratedArtComesFirst(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.Refresh(context.Background(), true)

	cover := s.state.Images[imageKey("game-port", "cover")]
	if cover == nil || cover.Source != "curated" || !strings.HasSuffix(cover.SourceURL, "/img/boxart.png") {
		t.Fatalf("port cover should come from the curated box art, got %+v", cover)
	}
	// emu-b has no website nor GitHub repo: the curated logo is its only source, and must be used.
	logo := s.state.Images[imageKey("emu-b", "logo")]
	if logo == nil || logo.Source != "curated" || logo.SHA256 == "" {
		t.Fatalf("emu-b logo should come from the curated icon, got %+v", logo)
	}
}
