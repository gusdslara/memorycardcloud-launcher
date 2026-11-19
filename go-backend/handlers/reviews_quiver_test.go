package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go-backend/database"
	"go-backend/internal/catalog"
	"go-backend/models"
)

// Catalog where the Android build of port "game-pc" comes from another repository (platformRepos),
// like most PC ports with a community Android port.
const quiverTestCatalog = `{
  "schemaVersion": 1,
  "ports": [
    {"kind":"port","id":"game-pc","name":"Game","author":"a","supportedOs":["windows","android"],"downloadUrls":{},
     "githubRepo":"Dev/Game-Recomp",
     "release":{"provider":"github","repo":"Dev/Game-Recomp","assets":{},"platformRepos":{"android":"Fan/Game-Android"}}},
    {"kind":"port","id":"other","name":"Other","author":"b","supportedOs":["windows"],"downloadUrls":{},"githubRepo":"x/other"}
  ]
}`

type fakeQuiver struct {
	mu        sync.Mutex
	calls     map[string]int
	userAgent string
	counts    map[string]int
}

func (f *fakeQuiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls[r.URL.Path]++
	f.userAgent = r.Header.Get("User-Agent")
	counts := map[string]int{}
	for k, v := range f.counts {
		counts[k] = v
	}
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/release-status":
		// two pages, to exercise the cursor
		if r.URL.Query().Get("cursor") == "" {
			w.Write([]byte(`{"items":[{"slug":"game-pc-quiver","provider":"github","repository":"dev/game-recomp"}],"nextCursor":"p2","isDone":false}`))
			return
		}
		w.Write([]byte(`{"items":[{"slug":"game-android-quiver","provider":"github","repository":"Fan/Game-Android"},
			{"slug":"unknown","provider":"github","repository":"nobody/nothing"},
			{"slug":"on-gitlab","provider":"gitlab","repository":"dev/game-recomp"}],"nextCursor":"","isDone":true}`))
	case "/api/v1/apps":
		items := []map[string]any{}
		for slug, n := range counts {
			items = append(items, map[string]any{"slug": slug, "reviewCount": n})
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items, "nextCursor": "", "isDone": true})
	case "/api/v1/apps/game-pc-quiver/reviews":
		w.Write([]byte(`{"items":[
			{"id":"r1","result":"runs","platform":"windows","version":"v1.0","body":"ótimo","createdAt":1794926614660,
			 "specs":{"osVersion":"Windows 11","cpu":"Ryzen 5 5600","gpu":"RTX 3060","ramGb":16},"specsPublic":true},
			{"id":"r2","result":"broken","platform":"linux","body":"crash","createdAt":1794900000000,
			 "specs":{"osVersion":"SteamOS 3.7"},"specsPublic":false},
			{"id":"r3","result":"issues","platform":"windows","body":"old","createdAt":1794800000000,"fixed":{"version":"v1.1","at":1}},
			{"id":"r4","result":"runs","platform":"windows","body":"hidden","createdAt":1794800000000,"moderatorHidden":true}
		],"nextCursor":"","isDone":true}`))
	case "/api/v1/apps/game-android-quiver/reviews":
		w.Write([]byte(`{"items":[{"id":"a1","result":"issues","platform":"android","body":"lento no Mali","createdAt":1794979025812}],"nextCursor":"","isDone":true}`))
	default:
		http.NotFound(w, r)
	}
}

func TestImportQuiverReviews(t *testing.T) {
	setupReviewsTest(t)
	cat, err := catalog.Parse([]byte(quiverTestCatalog))
	if err != nil {
		t.Fatal(err)
	}
	SetReviewCatalog(cat)
	fake := &fakeQuiver{calls: map[string]int{}, counts: map[string]int{"game-pc-quiver": 4, "game-android-quiver": 1, "unknown": 50}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	oldAPI, oldDelay := QuiverAPI, ReviewImportDelay
	QuiverAPI, ReviewImportDelay = srv.URL+"/api/v1", 0
	defer func() { QuiverAPI, ReviewImportDelay = oldAPI, oldDelay }()
	ctx := context.Background()

	res, err := ImportQuiverReviews(ctx, database.DB)
	if err != nil {
		t.Fatal(err)
	}
	// r1 + r2 (r3 fixed, r4 hidden) from the PC app, a1 from the Android app: all on port "game-pc"
	if res.Inserted != 3 || res.Fetched != 2 {
		t.Fatalf("run 1: %+v", res)
	}
	if fake.userAgent != reviewImportUserAgent {
		t.Fatalf("user agent %q", fake.userAgent)
	}
	if fake.calls["/api/v1/apps/unknown/reviews"] != 0 || fake.calls["/api/v1/apps/on-gitlab/reviews"] != 0 {
		t.Fatalf("fetched apps we don't list: %v", fake.calls)
	}
	var rows []models.PortReview
	database.DB.Where("port_id = ?", "game-pc").Order("created_at DESC").Find(&rows)
	if len(rows) != 3 {
		t.Fatalf("rows: %d", len(rows))
	}
	byPlatform := map[string]models.PortReview{}
	for _, r := range rows {
		byPlatform[r.Platform] = r
	}
	if a := byPlatform["android"]; a.Source != "quiver" || a.Verdict != "issues" || a.Note != "lento no Mali" || a.Author != quiverReviewAuthor {
		t.Fatalf("android row: %+v", a)
	}
	if w := byPlatform["windows"]; w.Hardware != "Windows 11 · Ryzen 5 5600 · RTX 3060 · 16 GB" || w.Version != "v1.0" {
		t.Fatalf("windows row: %+v", w)
	}
	if l := byPlatform["linux"]; l.Hardware != "" || l.Verdict != "broken" {
		t.Fatalf("private specs must not be copied: %+v", l)
	}

	// run 2: nothing changed → no report fetched
	res, err = ImportQuiverReviews(ctx, database.DB)
	if err != nil || res.Fetched != 0 || res.Skipped != 2 || res.Inserted != 0 {
		t.Fatalf("run 2: %+v %v", res, err)
	}

	// the reviews API filters by platform and still counts every platform for the tabs
	_, body := reviewReq(t, reviewsApp(), "GET", "/api/reviews?port=game-pc&platform=android", "", nil)
	var page struct {
		Platform  string              `json:"platform"`
		Summary   ReviewSummary       `json:"summary"`
		Platforms map[string]int      `json:"platforms"`
		Items     []models.PortReview `json:"items"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	if page.Platform != "android" || len(page.Items) != 1 || page.Summary.Total != 1 || page.Summary.Issues != 1 {
		t.Fatalf("android page: %s", body)
	}
	if page.Platforms["windows"] != 1 || page.Platforms["linux"] != 1 || page.Platforms["android"] != 1 {
		t.Fatalf("platform counts: %v", page.Platforms)
	}
	code, body := reviewReq(t, reviewsApp(), "GET", "/api/reviews?port=game-pc&platform=playstation", "", nil)
	if code != 400 || !strings.Contains(string(body), "Plataforma") {
		t.Fatalf("bad platform: %d %s", code, body)
	}
}
