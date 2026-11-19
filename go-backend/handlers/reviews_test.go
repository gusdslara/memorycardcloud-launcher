package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/internal/catalog"
	"go-backend/models"

	"github.com/glebarez/sqlite"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

const reviewTestCatalog = `{
  "schemaVersion": 1,
  "ports": [
    {"kind":"port","id":"port-a","name":"Port A","author":"x","supportedOs":["windows"],"downloadUrls":{},"externalIds":{"recomplauncher":"rl-a"}},
    {"kind":"port","id":"port-a-alt","name":"Port A (alt)","author":"y","supportedOs":["linux"],"downloadUrls":{},"alternativeOf":"port-a","externalIds":{"recomplauncher":"rl-a"}},
    {"kind":"port","id":"port-b","name":"Port B","author":"z","supportedOs":["windows"],"downloadUrls":{},"externalIds":{"recomplauncher":"rl-b"}},
    {"kind":"port","id":"port-c","name":"Port C","author":"z","supportedOs":["windows"],"downloadUrls":{}}
  ],
  "emulators": [
    {"kind":"emulator","id":"emu-x","name":"Emu X","author":"e","supportedOs":["windows"],"downloadUrls":{}}
  ]
}`

func setupReviewsTest(t *testing.T) {
	t.Helper()
	os.Setenv("JWT_SECRET", "testsecret1234567890123456789012")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "reviews.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	database.DB = db
	if err := db.AutoMigrate(&models.User{}, &models.PortReview{}, &models.ReviewImportState{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cat, err := catalog.Parse([]byte(reviewTestCatalog))
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	SetReviewCatalog(cat)
	reviewPostLimiter.Lock()
	reviewPostLimiter.hits = map[uint][]time.Time{}
	reviewPostLimiter.Unlock()
}

func reviewsApp() *fiber.App {
	app := fiber.New()
	app.Get("/api/reviews", GetReviews)
	app.Get("/api/reviews/summary", GetReviewSummaries)
	app.Post("/api/reviews", AuthMiddleware(), CreateReview)
	app.Delete("/api/reviews/:id", AuthMiddleware(), DeleteReview)
	return app
}

func reviewReq(t *testing.T, app *fiber.App, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func ip(v int) *int       { return &v }
func bp(v bool) *bool     { return &v }
func sp(v string) *string { return &v }

func TestBuildReviewSummariesMath(t *testing.T) {
	sums := buildReviewSummaries([]reviewAggRow{
		{PortID: "p", Source: "memorycard", Verdict: "runs", N: 3, RatingSum: 14, RatingN: 3, FPSSum: 150, FPSN: 3, StutterYes: 1, StutterNo: 2},
		{PortID: "p", Source: "memorycard", Verdict: "issues", N: 1, RatingSum: 2, RatingN: 1},
		{PortID: "p", Source: "recomplauncher", Verdict: "runs", N: 5},
		{PortID: "p", Source: "recomplauncher", Verdict: "broken", N: 2},
		{PortID: "q", Source: "recomplauncher", Verdict: "issues", N: 1},
	})
	p := sums["p"]
	if p.Total != 11 || p.Runs != 8 || p.Issues != 1 || p.Broken != 2 {
		t.Fatalf("counts: %+v", p)
	}
	if p.RatingCount != 4 || p.AvgRating == nil || *p.AvgRating != 4 {
		t.Fatalf("rating: count=%d avg=%v", p.RatingCount, p.AvgRating)
	}
	if p.AvgFPS == nil || *p.AvgFPS != 50 || p.StutterYes != 1 || p.StutterNo != 2 {
		t.Fatalf("fps/stutter: %+v", p)
	}
	if p.Sources["memorycard"] != 4 || p.Sources["recomplauncher"] != 7 {
		t.Fatalf("sources: %v", p.Sources)
	}
	q := sums["q"]
	if q.AvgRating != nil || q.AvgFPS != nil || q.Sources["memorycard"] != 0 || q.Total != 1 {
		t.Fatalf("q: %+v", q)
	}
}

func TestReviewsListAndSummaryEndpoints(t *testing.T) {
	setupReviewsTest(t)
	app := reviewsApp()
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	uid := uint(7)
	rows := []models.PortReview{
		{PortID: "port-a", Source: "memorycard", UserID: &uid, Author: "Ana B.", Platform: "windows", Rating: ip(5), Verdict: "runs", FPS: ip(60), Stutter: bp(false), CreatedAt: now.Add(-2 * time.Hour)},
		{PortID: "port-a", Source: "memorycard", Author: "Rui C.", Platform: "linux", Rating: ip(2), Verdict: "issues", FPS: ip(31), Stutter: bp(true), CreatedAt: now.Add(-1 * time.Hour)},
		{PortID: "port-a", Source: "recomplauncher", ExternalKey: sp("k1"), Author: reviewImportAuthor, Verdict: "broken", CreatedAt: now},
		{PortID: "port-a", Source: "recomplauncher", ExternalKey: sp("k2"), Author: reviewImportAuthor, Verdict: "runs", Hidden: true, CreatedAt: now},
		{PortID: "port-b", Source: "recomplauncher", ExternalKey: sp("k3"), Author: reviewImportAuthor, Verdict: "runs", CreatedAt: now},
	}
	if err := database.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}

	code, body := reviewReq(t, app, "GET", "/api/reviews?port=port-a", "", nil)
	if code != 200 {
		t.Fatalf("list: %d %s", code, body)
	}
	var list struct {
		Port    string            `json:"port"`
		Summary ReviewSummary     `json:"summary"`
		Items   []json.RawMessage `json:"items"`
	}
	json.Unmarshal(body, &list)
	s := list.Summary
	if list.Port != "port-a" || s.Total != 3 || s.Runs != 1 || s.Issues != 1 || s.Broken != 1 || len(list.Items) != 3 {
		t.Fatalf("list summary: %s", body)
	}
	if s.AvgRating == nil || *s.AvgRating != 3.5 || s.RatingCount != 2 || s.AvgFPS == nil || *s.AvgFPS != 45.5 {
		t.Fatalf("averages: %s", body)
	}
	if s.StutterYes != 1 || s.StutterNo != 1 || s.Sources["memorycard"] != 2 || s.Sources["recomplauncher"] != 1 {
		t.Fatalf("stutter/sources: %s", body)
	}
	var first map[string]any
	json.Unmarshal(list.Items[0], &first)
	if first["source"] != "recomplauncher" || first["rating"] != nil || first["createdAt"] != "2026-11-15T12:00:00Z" {
		t.Fatalf("newest first / shape: %s", list.Items[0])
	}
	for _, k := range []string{"id", "source", "author", "hardware", "platform", "version", "rating", "verdict", "fps", "stutter", "note", "createdAt"} {
		if _, ok := first[k]; !ok {
			t.Fatalf("item without %q: %s", k, list.Items[0])
		}
	}
	if len(first) != 12 {
		t.Fatalf("unexpected item fields: %s", list.Items[0])
	}

	if code, _ := reviewReq(t, app, "GET", "/api/reviews?port=port-a&limit=1&offset=1", "", nil); code != 200 {
		t.Fatalf("paged: %d", code)
	}
	_, body = reviewReq(t, app, "GET", "/api/reviews?port=port-a&limit=1&offset=1", "", nil)
	json.Unmarshal(body, &list)
	if len(list.Items) != 1 || !strings.Contains(string(list.Items[0]), "Rui C.") {
		t.Fatalf("pagination: %s", body)
	}
	if code, _ := reviewReq(t, app, "GET", "/api/reviews?port=nope", "", nil); code != 404 {
		t.Fatalf("unknown port: %d", code)
	}
	if code, _ := reviewReq(t, app, "GET", "/api/reviews?port=emu-x", "", nil); code != 404 {
		t.Fatalf("emulator is not a port: %d", code)
	}
	// port without reviews: empty summary
	_, body = reviewReq(t, app, "GET", "/api/reviews?port=port-c", "", nil)
	if !strings.Contains(string(body), `"items":[]`) || !strings.Contains(string(body), `"avgRating":null`) ||
		!strings.Contains(string(body), `"sources":{"memorycard":0,"quiver":0,"recomplauncher":0}`) {
		t.Fatalf("empty port: %s", body)
	}

	code, body = reviewReq(t, app, "GET", "/api/reviews/summary", "", nil)
	if code != 200 {
		t.Fatalf("summary: %d", code)
	}
	var all struct {
		Ports map[string]ReviewSummary `json:"ports"`
	}
	json.Unmarshal(body, &all)
	if len(all.Ports) != 2 || all.Ports["port-a"].Total != 3 || all.Ports["port-b"].Runs != 1 {
		t.Fatalf("summary body: %s", body)
	}
}

func TestCreateReviewValidationUpsertAndDelete(t *testing.T) {
	setupReviewsTest(t)
	app := reviewsApp()
	user := models.User{Email: "gustavo@example.com", Name: "Gustavo Lima"}
	other := models.User{Email: "outro@example.com", Name: "outro@example.com"}
	admin := models.User{Email: "admin@example.com", IsAdmin: true}
	for _, u := range []*models.User{&user, &other, &admin} {
		if err := database.DB.Create(u).Error; err != nil {
			t.Fatal(err)
		}
	}
	tok := createRomTestToken(user.ID)

	valid := func() map[string]any {
		return map[string]any{"port": "port-a", "platform": "windows", "version": "1.2.0",
			"hardware": "Ryzen 5 5600 · RTX 3060 · 16 GB", "rating": 5, "fps": 60, "stutter": false}
	}
	bad := []func(m map[string]any){
		func(m map[string]any) { delete(m, "rating") },
		func(m map[string]any) { m["rating"] = 0 },
		func(m map[string]any) { m["rating"] = 6 },
		func(m map[string]any) { m["platform"] = "ps2" },
		func(m map[string]any) { m["platform"] = "" },
		func(m map[string]any) { m["hardware"] = "   " },
		func(m map[string]any) { m["hardware"] = strings.Repeat("é", 301) },
		func(m map[string]any) { m["note"] = strings.Repeat("a", 501) },
		func(m map[string]any) { m["port"] = "nope" },
		func(m map[string]any) { m["port"] = "emu-x" },
		func(m map[string]any) { m["fps"] = 0 },
		func(m map[string]any) { m["fps"] = 1001 },
	}
	for i, mut := range bad {
		m := valid()
		mut(m)
		if code, body := reviewReq(t, app, "POST", "/api/reviews", tok, m); code != 400 {
			t.Fatalf("bad case %d: %d %s", i, code, body)
		}
	}
	if code, _ := reviewReq(t, app, "POST", "/api/reviews", "", valid()); code != 401 {
		t.Fatalf("no token: %d", code)
	}

	// create
	m := valid()
	m["note"] = "  roda liso  "
	m["hardware"] = strings.Repeat("é", 300)
	code, body := reviewReq(t, app, "POST", "/api/reviews", tok, m)
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	var saved map[string]any
	json.Unmarshal(body, &saved)
	if saved["author"] != "Gustavo L." || saved["verdict"] != "runs" || saved["note"] != "roda liso" || saved["source"] != "memorycard" {
		t.Fatalf("saved: %s", body)
	}
	if strings.Contains(string(body), "example.com") {
		t.Fatalf("email leaked: %s", body)
	}
	id := saved["id"].(float64)

	// same (user, port, platform) → replaces
	m = valid()
	m["rating"] = 3
	delete(m, "fps")
	code, body = reviewReq(t, app, "POST", "/api/reviews", tok, m)
	json.Unmarshal(body, &saved)
	if code != 200 || saved["id"].(float64) != id || saved["verdict"] != "issues" || saved["fps"] != nil {
		t.Fatalf("upsert: %d %s", code, body)
	}
	m["rating"] = 1
	m["platform"] = "linux"
	code, body = reviewReq(t, app, "POST", "/api/reviews", tok, m)
	json.Unmarshal(body, &saved)
	if code != 201 || saved["id"].(float64) == id || saved["verdict"] != "broken" {
		t.Fatalf("other platform: %d %s", code, body)
	}
	linuxID := saved["id"].(float64)
	var n int64
	database.DB.Model(&models.PortReview{}).Count(&n)
	if n != 2 {
		t.Fatalf("expected 2 reviews, got %d", n)
	}

	// author fallback when the name is an e-mail
	code, body = reviewReq(t, app, "POST", "/api/reviews", createRomTestToken(other.ID), valid())
	if code != 201 || !strings.Contains(string(body), `"author":"Jogador"`) {
		t.Fatalf("fallback author: %d %s", code, body)
	}

	// summary cache is invalidated by POST
	_, body = reviewReq(t, app, "GET", "/api/reviews/summary", "", nil)
	if !strings.Contains(string(body), `"total":3`) {
		t.Fatalf("summary after posts: %s", body)
	}

	// delete: other user → 403, owner → ok, admin → ok
	del := func(tokenUser uint, rid float64) int {
		code, _ := reviewReq(t, app, "DELETE", "/api/reviews/"+strconv.Itoa(int(rid)), createRomTestToken(tokenUser), nil)
		return code
	}
	if c := del(other.ID, id); c != 403 {
		t.Fatalf("delete by other: %d", c)
	}
	if c := del(user.ID, id); c != 200 {
		t.Fatalf("delete by owner: %d", c)
	}
	if c := del(user.ID, id); c != 404 {
		t.Fatalf("delete twice: %d", c)
	}
	if c := del(admin.ID, linuxID); c != 200 {
		t.Fatalf("delete by admin: %d", c)
	}
	_, body = reviewReq(t, app, "GET", "/api/reviews/summary", "", nil)
	if !strings.Contains(string(body), `"total":1`) {
		t.Fatalf("summary after deletes: %s", body)
	}

	// imported reports are hidden, not deleted
	imp := models.PortReview{PortID: "port-b", Source: "recomplauncher", ExternalKey: sp("x"), Verdict: "runs"}
	database.DB.Create(&imp)
	if c := del(admin.ID, float64(imp.ID)); c != 200 {
		t.Fatalf("hide imported: %d", c)
	}
	var hidden models.PortReview
	if err := database.DB.First(&hidden, imp.ID).Error; err != nil || !hidden.Hidden {
		t.Fatalf("imported row should stay hidden: %v %+v", err, hidden)
	}
}

func TestCreateReviewRateLimit(t *testing.T) {
	setupReviewsTest(t)
	app := reviewsApp()
	user := models.User{Email: "r@example.com", Name: "Rita"}
	database.DB.Create(&user)
	tok := createRomTestToken(user.ID)
	body := map[string]any{"port": "port-c", "platform": "windows", "hardware": "PC", "rating": 4}
	for i := 0; i < reviewPostsPerHour; i++ {
		if code, b := reviewReq(t, app, "POST", "/api/reviews", tok, body); code != 200 && code != 201 {
			t.Fatalf("post %d: %d %s", i, code, b)
		}
	}
	if code, _ := reviewReq(t, app, "POST", "/api/reviews", tok, body); code != 429 {
		t.Fatalf("expected 429, got %d", code)
	}
}

// fake RecompLauncher API
type fakeRL struct {
	mu        sync.Mutex
	counts    map[string]map[string]int
	feedback  map[string]string // rlId → JSON body
	blockID   string            // rlId answering 429
	calls     map[string]int    // "counts" | "feedback:<id>"
	userAgent string
}

func (f *fakeRL) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.userAgent = r.Header.Get("User-Agent")
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Query().Get("a") {
	case "counts":
		f.calls["counts"]++
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "counts": f.counts})
	case "feedback":
		id := r.URL.Query().Get("id")
		f.calls["feedback:"+id]++
		if id == f.blockID {
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, f.feedback[id])
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}

const rlFeedbackA = `{"ok":true,"counts":{"runs":2,"issues":0,"broken":1},"items":[
 {"verdict":"runs","sys":"windows","proton":false,"version":"v0.0.7.0","note":"  liso  ","specs":"Windows 11 Pro · Core i9-9900KF · RTX 3080 Ti · 32 GB","log":false,"replies":[],"when":"2026-11-14T23:37:23+00:00"},
 {"verdict":"broken","sys":"linux","proton":true,"version":"v0.0.6.0","note":"","specs":"Steam Deck","log":false,"replies":[],"when":"2026-11-10T10:00:00+00:00"},
 {"verdict":"weird","sys":"windows","version":"v1","note":"","specs":"x","when":"2026-11-10T10:00:00+00:00"}
],"proton":{},"latest":{}}`

const rlFeedbackB = `{"ok":true,"counts":{"runs":1},"items":[
 {"verdict":"issues","sys":"steamos","proton":false,"version":"1.0","note":"trava às vezes","specs":"PC","log":false,"replies":[],"when":"2026-11-12T08:00:00+00:00"}
]}`

func TestImportRecompLauncherReviews(t *testing.T) {
	setupReviewsTest(t)
	fake := &fakeRL{
		counts: map[string]map[string]int{
			"rl-a":     {"runs": 2, "broken": 1},
			"rl-b":     {"issues": 1},
			"rl-other": {"runs": 99}, // not referenced by the catalog: never fetched
		},
		feedback: map[string]string{"rl-a": rlFeedbackA, "rl-b": rlFeedbackB},
		blockID:  "rl-b",
		calls:    map[string]int{},
	}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	oldAPI, oldDelay := RecompLauncherAPI, ReviewImportDelay
	RecompLauncherAPI, ReviewImportDelay = srv.URL+"/api/pc.php", 0
	defer func() { RecompLauncherAPI, ReviewImportDelay = oldAPI, oldDelay }()
	ctx := context.Background()

	// run 1: rl-a imported for both ports mapping to it, rl-b answers 429 → run stops
	res, err := ImportRecompLauncherReviews(ctx, database.DB)
	var blocked *errReviewImportBlocked
	if !errors.As(err, &blocked) || blocked.Status != 429 || blocked.RetryAfter != 120*time.Second {
		t.Fatalf("expected 429 stop with Retry-After, got %v", err)
	}
	if res.Inserted != 4 {
		t.Fatalf("run 1 inserted %d, want 4 (2 valid reports × 2 ports)", res.Inserted)
	}
	if fake.userAgent != "MemoryCardCloud-Reviews/1.0 (+https://memorycard.cloud)" {
		t.Fatalf("user agent: %q", fake.userAgent)
	}
	if fake.calls["counts"] != 1 || fake.calls["feedback:rl-a"] != 1 || fake.calls["feedback:rl-b"] != 1 || fake.calls["feedback:rl-other"] != 0 {
		t.Fatalf("calls run 1: %v", fake.calls)
	}
	var rows []models.PortReview
	database.DB.Where("port_id = ?", "port-a-alt").Order("created_at DESC").Find(&rows)
	if len(rows) != 2 {
		t.Fatalf("port-a-alt rows: %d", len(rows))
	}
	r0 := rows[0]
	if r0.Author != reviewImportAuthor || r0.Source != "recomplauncher" || r0.Platform != "windows" || r0.Rating != nil ||
		r0.FPS != nil || r0.Stutter != nil || r0.Note != "liso" || r0.Version != "v0.0.7.0" || r0.ExternalKey == nil ||
		!r0.CreatedAt.Equal(time.Date(2026, 11, 14, 23, 37, 23, 0, time.UTC)) || !strings.HasPrefix(r0.Hardware, "Windows 11 Pro") {
		t.Fatalf("imported row: %+v", r0)
	}
	var states []models.ReviewImportState
	database.DB.Find(&states)
	if len(states) != 1 || states[0].ExternalID != "rl-a" || states[0].Total != 3 {
		t.Fatalf("states after run 1: %+v", states)
	}

	// run 2: rl-a unchanged → not fetched; rl-b now answers
	fake.blockID = ""
	res, err = ImportRecompLauncherReviews(ctx, database.DB)
	if err != nil || res.Inserted != 1 || res.Skipped != 1 {
		t.Fatalf("run 2: %+v %v", res, err)
	}
	if fake.calls["feedback:rl-a"] != 1 || fake.calls["feedback:rl-b"] != 2 || fake.calls["counts"] != 2 {
		t.Fatalf("calls run 2: %v", fake.calls)
	}
	var b models.PortReview
	database.DB.Where("port_id = ?", "port-b").First(&b)
	if b.Platform != "" || b.Verdict != "issues" {
		t.Fatalf("port-b row: %+v", b)
	}

	// run 3: rl-a total changed, same reports → fetched again, deduped by external key
	fake.counts["rl-a"] = map[string]int{"runs": 3, "broken": 1}
	res, err = ImportRecompLauncherReviews(ctx, database.DB)
	if err != nil || res.Inserted != 0 || res.Fetched != 1 {
		t.Fatalf("run 3: %+v %v", res, err)
	}
	var total int64
	database.DB.Model(&models.PortReview{}).Count(&total)
	if total != 5 {
		t.Fatalf("total rows: %d", total)
	}

	// summary reflects the import
	_, body := reviewReq(t, reviewsApp(), "GET", "/api/reviews/summary", "", nil)
	if !strings.Contains(string(body), `"port-a-alt":{"total":2,"runs":1,"issues":0,"broken":1`) {
		t.Fatalf("summary after import: %s", body)
	}
}

func TestImporterSkipsWithoutMappedPorts(t *testing.T) {
	setupReviewsTest(t)
	cat, _ := catalog.Parse([]byte(`{"schemaVersion":1,"ports":[{"kind":"port","id":"p","name":"P","author":"a","supportedOs":[],"downloadUrls":{}}]}`))
	SetReviewCatalog(cat)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	old := RecompLauncherAPI
	RecompLauncherAPI = srv.URL
	defer func() { RecompLauncherAPI = old }()
	if _, err := ImportRecompLauncherReviews(context.Background(), database.DB); err != nil || hits != 0 {
		t.Fatalf("expected no request: hits=%d err=%v", hits, err)
	}
}

func TestReviewAuthorName(t *testing.T) {
	cases := map[string]string{
		"Gustavo Lima":       "Gustavo L.",
		"gustavo lima souza": "gustavo S.",
		"  Ana  ":            "Ana",
		"":                   "Jogador",
		"a@b.com":            "Jogador",
		"Érica ávila":        "Érica Á.",
	}
	for in, want := range cases {
		if got := reviewAuthorName(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}
