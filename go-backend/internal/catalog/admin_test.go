package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// failingWiki answers the Wikipedia REST summary with 429 and the action API with a disambiguation page,
// until ok is set: then both return a real game article with an image.
func failingWiki(t *testing.T, img string, ok *atomic.Bool) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok.Load() {
			if strings.Contains(r.URL.Path, "/page/summary/") {
				json.NewEncoder(w).Encode(map[string]any{"type": "standard", "description": "1993 video game", "originalimage": map[string]any{"source": img, "width": 600}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": []any{map[string]any{"title": "x", "description": "1993 video game", "original": map[string]any{"source": img, "width": 600}}}}})
			return
		}
		if strings.Contains(r.URL.Path, "/page/summary/") {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": []any{map[string]any{"title": "x", "pageprops": map[string]string{"disambiguation": ""}}}}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func resultsOf(atts []ImageAttempt) map[string]int {
	out := map[string]int{}
	for _, a := range atts {
		out[a.Result]++
	}
	return out
}

func TestAttemptLogExplainsEveryFailureAndRescrapeFixesIt(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.syncJobs = true
	var wikiOK atomic.Bool
	wiki := failingWiki(t, f.srv.URL+"/img/wiki-cover.png", &wikiOK)
	s.cfg.WikipediaAPI, s.cfg.WikipediaActionAPI = wiki.URL, wiki.URL+"/w/api.php"

	it := s.cat.Get("game-port")
	// curated cover gone (404) + an "image" that is an HTML page
	it.Art = &ArtHints{Covers: []ArtRef{{URL: f.srv.URL + "/gone.png", Fit: "cover"}, {URL: f.srv.URL + "/site/", Fit: "contain"}}}
	now := time.Now()
	if r := s.checkImage(context.Background(), it, "cover", now, false); !r.Checked || r.Found {
		t.Fatalf("expected a failed check, got %+v", r)
	}
	st := s.state.Images[imageKey(it.ID, "cover")]
	got := resultsOf(st.Attempts)
	if got[ResultHTTP] != 1 || got[ResultRateLimited] == 0 || got[ResultRejected] == 0 || got[ResultNotImage] != 1 {
		t.Fatalf("attempt log does not explain the failures: %+v", st.Attempts)
	}
	for _, a := range st.Attempts {
		if a.Result == ResultHTTP && a.Status != http.StatusNotFound {
			t.Errorf("404 expected in the log, got %+v", a)
		}
		if a.Result == ResultRateLimited && a.Status != http.StatusTooManyRequests {
			t.Errorf("429 expected, got %+v", a)
		}
	}
	if st.CheckedAt.IsZero() || st.Failures != 1 || !strings.Contains(st.LastError, "nenhuma imagem") {
		t.Fatalf("state not updated: %+v", st)
	}
	s.mu.Lock()
	v := s.imageViewLocked(it, "cover", true)
	s.mu.Unlock()
	if v.Status != StatusMissing || !v.HasErrors {
		t.Fatalf("admin view: %+v", v)
	}

	// Not due again yet, but the admin forces it after Wikipedia is back.
	wikiOK.Store(true)
	kinds, err := s.RescrapeItem(it.ID, "cover")
	if err != nil || len(kinds) != 1 {
		t.Fatalf("rescrape: %v %v", kinds, err)
	}
	st = s.state.Images[imageKey(it.ID, "cover")]
	if st.SHA256 == "" || st.Source != "wikipedia" || !strings.HasSuffix(st.SourceURL, "/img/wiki-cover.png") {
		t.Fatalf("rescrape did not store the cover: %+v", st)
	}
	if last := st.Attempts[len(st.Attempts)-1]; last.Result != ResultOK {
		t.Fatalf("last attempt must be the success: %+v", last)
	}
	if len(s.jobs) != 0 {
		t.Fatal("job not cleared")
	}
	// persisted with the attempt log
	s2, err := New(s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if st2 := s2.state.Images[imageKey(it.ID, "cover")]; st2 == nil || len(st2.Attempts) == 0 {
		t.Fatal("attempts not persisted")
	}
}

func TestAttemptLogIsBounded(t *testing.T) {
	var l attemptLog
	for i := 0; i < maxAttempts+10; i++ {
		l.add(ImageAttempt{Source: "x", Result: ResultNoMatch})
	}
	l[len(l)-1].Result = ResultOK
	b := l.bounded()
	if len(b) != maxAttempts || b[len(b)-1].Result != ResultOK {
		t.Fatalf("bounded log: %d entries, last %+v", len(b), b[len(b)-1])
	}
}

func TestFallbackImages(t *testing.T) {
	it := &Item{ID: "x", Kind: "port", Art: &ArtHints{Covers: []ArtRef{{URL: "https://a/box.png", Fit: "cover"}, {URL: "https://a/icon.png", Fit: "contain"}}}}
	cases := []struct {
		st   ImageState
		want bool
	}{
		{ImageState{Source: "curated", SourceURL: "https://a/box.png"}, false},
		{ImageState{Source: "curated", SourceURL: "https://a/icon.png"}, true},
		{ImageState{Source: "github", SourceURL: "https://github.com/acme.png"}, true},
		{ImageState{Source: "wikipedia", SourceURL: "https://upload.wikimedia.org/logo.svg"}, true},
		{ImageState{Source: "steam", SourceURL: "https://cdn/library_600x900.jpg"}, false},
	}
	for _, c := range cases {
		if got := isFallbackImage(it, "cover", &c.st); got != c.want {
			t.Errorf("%+v: got %v", c.st, got)
		}
	}
}

func adminDo(t *testing.T, s *Service, method, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.AdminHandler().ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec, body
}

func TestAdminEndpoints(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	s.syncJobs = true
	if _, err := s.Refresh(context.Background(), false); err != nil {
		t.Fatal(err)
	}

	rec, body := adminDo(t, s, "GET", "/api/admin/scrape/status")
	if rec.Code != 200 || body["enabled"] != true {
		t.Fatalf("status: %d %s", rec.Code, rec.Body)
	}
	sc := body["scraper"].(map[string]any)
	cov := sc["coverage"].(map[string]any)["port:cover"].(map[string]any)
	if cov["total"].(float64) != 1 || cov["ok"].(float64) != 1 {
		t.Fatalf("coverage: %+v", cov)
	}
	if runs := sc["runs"].([]any); len(runs) != 1 || runs[0].(map[string]any)["imagesFound"].(float64) < 1 {
		t.Fatalf("run history: %+v", sc["runs"])
	}
	if b := body["build"].(map[string]any); b["runner"].(map[string]any)["enabled"] != false || len(b["jobs"].([]any)) == 0 {
		t.Fatalf("build: %+v", b)
	}

	rec, body = adminDo(t, s, "GET", "/api/admin/scrape/items?type=all&filter=all&q=emu")
	if rec.Code != 200 || body["total"].(float64) != 2 {
		t.Fatalf("items search: %s", rec.Body)
	}
	rec, body = adminDo(t, s, "GET", "/api/admin/scrape/items?filter=missing")
	if rec.Code != 200 || body["total"].(float64) != 0 || body["counts"].(map[string]any)["all"].(float64) != 1 {
		t.Fatalf("items missing: %s", rec.Body)
	}

	rec, body = adminDo(t, s, "GET", "/api/admin/scrape/items/game-port")
	if rec.Code != 200 || len(body["images"].([]any)) != 2 || len(body["plan"].(map[string]any)["cover"].([]any)) == 0 {
		t.Fatalf("item: %s", rec.Body)
	}
	if rec, _ := adminDo(t, s, "GET", "/api/admin/scrape/items/nope"); rec.Code != 404 {
		t.Fatalf("unknown item: %d", rec.Code)
	}
	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/items/emu-a/rescrape?kind=cover"); rec.Code != 400 {
		t.Fatalf("emulators have no cover: %d", rec.Code)
	}
	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/items/game-port/rescrape?kind=cover"); rec.Code != 202 {
		t.Fatalf("rescrape: %d %s", rec.Code, rec.Body)
	}
	s.mu.Lock()
	s.jobs[imageKey("game-port", "cover")] = time.Now()
	s.mu.Unlock()
	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/items/game-port/rescrape?kind=cover"); rec.Code != 409 {
		t.Fatalf("busy rescrape: %d", rec.Code)
	}

	s.running.Store(true)
	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/run"); rec.Code != 409 {
		t.Fatalf("run while running: %d", rec.Code)
	}
	s.running.Store(false)
	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/run?force=1&retry=1"); rec.Code != 202 {
		t.Fatalf("run: %d", rec.Code)
	}
	deadline := time.Now().Add(10 * time.Second)
	for s.running.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.running.Load() {
		t.Fatal("admin run did not finish")
	}
	if s.lastRun.Trigger != "admin" || !s.lastRun.Forced {
		t.Fatalf("admin run not recorded: %+v", s.lastRun)
	}

	if rec, _ := adminDo(t, s, "POST", "/api/admin/scrape/build/run?job=art"); rec.Code != http.StatusNotImplemented {
		t.Fatalf("build runner must be off without CATALOG_BUILD_ROOT: %d", rec.Code)
	}
	if rec, _ := adminDo(t, s, "GET", "/api/admin/scrape/build/report"); rec.Code != 200 || rec.Header().Get("X-Report-Source") == "" {
		t.Fatalf("build report: %d", rec.Code)
	}
}

func TestRunHistoryPersistsAndIsBounded(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	for i := 0; i < maxRuns+3; i++ {
		s.Refresh(context.Background(), false)
	}
	s2, err := New(s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.state.Runs) != maxRuns || s2.lastRun.StartedAt.IsZero() {
		t.Fatalf("runs after restart: %d, last %+v", len(s2.state.Runs), s2.lastRun)
	}
}

func TestBuildReportNewestWinsAndSummaries(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "build-report.json")
	b := buildRunner{}
	b.init(Config{BuildReportPath: path})
	if _, src := b.report(); src != "embedded" {
		t.Fatalf("embedded report expected, got %q", src)
	}
	rep := `{"schemaVersion":1,"generatedAt":"2999-01-01T00:00:00Z","sections":{"art":{"at":"2999-01-01T00:00:00Z","games":3,
	  "missing":[{"title":"Some Game","attempts":[{"source":"steam","result":"no_match"}]}],"fallback":[{"title":"Other","best":{"url":"u"}}]}}}`
	os.WriteFile(path, []byte(rep), 0o644)
	raw, src := b.report()
	if src != "runtime" {
		t.Fatalf("newer runtime report must win, got %q", src)
	}
	sum := summarizeReport(raw)
	art := sum["sections"].(map[string]any)["art"].(map[string]any)
	if art["missingCount"] != 1 || art["fallbackCount"] != 1 || art["missing"] != nil {
		t.Fatalf("summary: %+v", art)
	}
	if e := buildArtFor(raw, "", "Some Game"); e == nil || e.Status != "missing" || len(e.Attempts) != 1 {
		t.Fatalf("buildArtFor: %+v", e)
	}
	if e := buildArtFor(raw, "Other"); e == nil || e.Status != "fallback" {
		t.Fatalf("buildArtFor fallback: %+v", e)
	}
}

func TestBuildRunnerRunsNodeScripts(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "scripts", "catalog"), 0o755)
	os.WriteFile(filepath.Join(root, "scripts", "catalog", "build-art.mjs"),
		[]byte(`console.log("art ok", process.argv.slice(2).join(" "), process.env.CATALOG_BUILD_REPORT ? "report" : "");`), 0o644)
	b := buildRunner{}
	b.init(Config{BuildRoot: root, NodeBin: node, BuildReportPath: filepath.Join(root, "r.json")})
	if v := b.view(false); !v.Enabled {
		t.Fatalf("runner should be enabled: %s", v.Reason)
	}
	if err := b.start("nope", false, 0); err == nil {
		t.Fatal("unknown job must be refused")
	}
	if err := b.start("art", true, 30); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for b.view(false).Running && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	v := b.view(true)
	if v.Running || v.ExitCode == nil || *v.ExitCode != 0 {
		t.Fatalf("job did not finish cleanly: %+v", v)
	}
	if !strings.Contains(strings.Join(v.Log, "\n"), "art ok --offline --budget 30 report") {
		t.Fatalf("log: %q", v.Log)
	}
}
