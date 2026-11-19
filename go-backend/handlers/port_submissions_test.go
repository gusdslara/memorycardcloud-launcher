package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/internal/catalog"
	"go-backend/models"

	"github.com/glebarez/sqlite"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

const portSubTestCatalog = `{
  "schemaVersion": 1,
  "ports": [
    {"kind":"port","id":"soh","name":"Ship of Harkinian","author":"HM","githubRepo":"HarbourMasters/Shipwright","supportedOs":["windows"],"downloadUrls":{}}
  ],
  "emulators": []
}`

func setupPortSubTest(t *testing.T) (app *fiber.App, user, other, admin models.User) {
	t.Helper()
	t.Setenv("JWT_SECRET", "testsecret1234567890123456789012")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "portsubs.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	database.DB = db
	if err := db.AutoMigrate(&models.User{}, &models.PortSubmission{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cat, err := catalog.Parse([]byte(portSubTestCatalog))
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	SetReviewCatalog(cat)
	t.Cleanup(func() {
		reviewCatMu.Lock()
		reviewCat, reviewCatErr = nil, nil
		reviewCatMu.Unlock()
	})
	portSubLimiter.Lock()
	portSubLimiter.hits = map[uint][]time.Time{}
	portSubLimiter.Unlock()
	invalidateCommunityPorts()

	user = models.User{Email: "ana@example.com", Name: "Ana Souza"}
	other = models.User{Email: "rui@example.com", Name: "Rui"}
	admin = models.User{Email: "admin@example.com", IsAdmin: true}
	for _, u := range []*models.User{&user, &other, &admin} {
		if err := db.Create(u).Error; err != nil {
			t.Fatal(err)
		}
	}

	app = fiber.New()
	app.Get("/api/ports/community", GetCommunityPorts)
	app.Post("/api/ports/submissions", AuthMiddleware(), CreatePortSubmission)
	app.Get("/api/ports/submissions/mine", AuthMiddleware(), MyPortSubmissions)
	g := app.Group("/api/admin", AuthMiddleware(), AdminMiddleware)
	g.Get("/ports/submissions", AdminListPortSubmissions)
	g.Post("/ports/submissions/:id/approve", AdminApprovePortSubmission)
	g.Post("/ports/submissions/:id/reject", AdminRejectPortSubmission)
	g.Delete("/ports/submissions/:id", AdminDeletePortSubmission)
	return
}

func validPortSub() map[string]any {
	return map[string]any{
		"name":        "Zelda64Recomp",
		"projectName": "The Legend of Zelda: Majora's Mask",
		"console":     "Nintendo 64",
		"portType":    "recomp",
		"author":      "Zelda64Recomp team",
		"description": "Recompilação estática.",
		"githubRepo":  "https://github.com/Zelda64Recomp/Zelda64Recomp/releases",
		"supportedOs": []string{"windows", "linux", "windows", "ios"},
		"downloadUrls": map[string]string{
			"windows": "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/latest/download/win.zip",
		},
		"executableNames": map[string]string{"windows": "Zelda64Recompiled.exe"},
		"romRequirements": map[string]any{
			"fileType": "file", "extensions": []string{".z64", " .z64 ", ""}, "fileDescription": "ROM US", "instructions": "Selecione a ROM.",
		},
		"isCustom": true,
		"release":  map[string]any{"provider": "github", "repo": "Zelda64Recomp/Zelda64Recomp", "assets": map[string]string{}},
		"stats":    map[string]any{"score": 999}, // not whitelisted: dropped
	}
}

func TestPortSubmissionNormalize(t *testing.T) {
	setupPortSubTest(t)
	raw, _ := json.Marshal(validPortSub())
	var p PortSubmissionPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if err := p.normalize(); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if p.ID != "zelda64recomp" || p.GithubRepo != "Zelda64Recomp/Zelda64Recomp" || !p.Community {
		t.Fatalf("id/repo/community: %+v", p)
	}
	if strings.Join(p.SupportedOS, ",") != "windows,linux,ios" || len(p.RomRequirements.Extensions) != 1 || p.Release != nil {
		t.Fatalf("lists: os=%v ext=%v release=%v", p.SupportedOS, p.RomRequirements.Extensions, p.Release)
	}

	cases := []struct {
		mut   func(m map[string]any)
		field string
	}{
		{func(m map[string]any) { m["name"] = " " }, "name"},
		{func(m map[string]any) { m["console"] = "All" }, "console"},
		{func(m map[string]any) { m["portType"] = "emulator" }, "portType"},
		{func(m map[string]any) { m["supportedOs"] = []string{"dos"} }, "supportedOs"},
		{func(m map[string]any) { m["supportedOs"] = []string{} }, "supportedOs"},
		{func(m map[string]any) { m["githubRepo"] = "not a repo" }, "githubRepo"},
		{func(m map[string]any) { m["downloadUrls"] = map[string]string{"windows": "ftp://x/y.zip"} }, "downloadUrl"},
		{func(m map[string]any) { m["executableNames"] = map[string]string{"windows": "../../evil.exe"} }, "executableName"},
		{func(m map[string]any) {
			m["githubRepo"], m["downloadUrls"], m["release"] = "", map[string]string{}, nil
		}, "downloadUrl"},
		{func(m map[string]any) { m["romRequirements"] = map[string]any{"fileType": "disk"} }, "romFileType"},
		{func(m map[string]any) { m["description"] = strings.Repeat("a", 1001) }, "description"},
	}
	for i, tc := range cases {
		m := validPortSub()
		tc.mut(m)
		raw, _ := json.Marshal(m)
		var p PortSubmissionPayload
		json.Unmarshal(raw, &p)
		err := p.normalize()
		fe, ok := err.(*portSubFieldError)
		if !ok || fe.Field != tc.field {
			t.Errorf("case %d: want field %q, got %v", i, tc.field, err)
		}
	}
}

func TestPortSubmissionFlow(t *testing.T) {
	app, user, other, admin := setupPortSubTest(t)
	userTok, otherTok, adminTok := createRomTestToken(user.ID), createRomTestToken(other.ID), createRomTestToken(admin.ID)

	// login required
	if code, _ := reviewReq(t, app, "POST", "/api/ports/submissions", "", validPortSub()); code != 401 {
		t.Fatalf("anon submit: %d", code)
	}
	// field error comes back with the field name
	bad := validPortSub()
	bad["console"] = "Atari"
	code, body := reviewReq(t, app, "POST", "/api/ports/submissions", userTok, bad)
	if code != 400 || !strings.Contains(string(body), `"field":"console"`) {
		t.Fatalf("bad console: %d %s", code, body)
	}
	// already in the official catalog (same repo)
	dup := validPortSub()
	dup["githubRepo"] = "harbourmasters/shipwright"
	if code, body := reviewReq(t, app, "POST", "/api/ports/submissions", userTok, dup); code != 409 {
		t.Fatalf("catalog dup: %d %s", code, body)
	}

	// create
	code, body = reviewReq(t, app, "POST", "/api/ports/submissions", userTok, validPortSub())
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	var created struct {
		Submission portSubView `json:"submission"`
	}
	json.Unmarshal(body, &created)
	sub := created.Submission
	if sub.ID == 0 || sub.Status != "pending" || sub.PortID != "zelda64recomp" || sub.UserEmail != "" || sub.Payload != nil {
		t.Fatalf("created view: %s", body)
	}

	// same user again → updates the pending one; another user → 409
	again := validPortSub()
	again["description"] = "Atualizado"
	code, body = reviewReq(t, app, "POST", "/api/ports/submissions", userTok, again)
	if code != 200 || !strings.Contains(string(body), `"updated":true`) {
		t.Fatalf("resubmit: %d %s", code, body)
	}
	if code, body := reviewReq(t, app, "POST", "/api/ports/submissions", otherTok, validPortSub()); code != 409 {
		t.Fatalf("other dup: %d %s", code, body)
	}
	var n int64
	database.DB.Model(&models.PortSubmission{}).Count(&n)
	if n != 1 {
		t.Fatalf("rows: %d", n)
	}

	// id taken by the curated catalog → prefixed
	soh := validPortSub()
	soh["id"], soh["name"], soh["githubRepo"] = "soh", "SoH fork", "someone/soh-fork"
	code, body = reviewReq(t, app, "POST", "/api/ports/submissions", otherTok, soh)
	if code != 201 || !strings.Contains(string(body), `"portId":"community-soh"`) {
		t.Fatalf("prefixed id: %d %s", code, body)
	}
	var sohView struct {
		Submission portSubView `json:"submission"`
	}
	json.Unmarshal(body, &sohView)

	// too big
	huge := validPortSub()
	huge["longDescription"] = strings.Repeat("x", portSubMaxBody)
	if code, _ := reviewReq(t, app, "POST", "/api/ports/submissions", userTok, huge); code != 413 {
		t.Fatalf("too big: %d", code)
	}

	// mine
	code, body = reviewReq(t, app, "GET", "/api/ports/submissions/mine", userTok, nil)
	if code != 200 || strings.Count(string(body), `"id":`) != 1 || !strings.Contains(string(body), `"status":"pending"`) {
		t.Fatalf("mine: %d %s", code, body)
	}

	// admin only
	if code, _ := reviewReq(t, app, "GET", "/api/admin/ports/submissions", userTok, nil); code != 403 {
		t.Fatalf("non-admin list: %d", code)
	}
	code, body = reviewReq(t, app, "GET", "/api/admin/ports/submissions?status=pending", adminTok, nil)
	var list struct {
		Items  []portSubView    `json:"items"`
		Counts map[string]int64 `json:"counts"`
	}
	json.Unmarshal(body, &list)
	if code != 200 || len(list.Items) != 2 || list.Counts["pending"] != 2 || list.Counts["total"] != 2 {
		t.Fatalf("admin list: %d %s", code, body)
	}
	if list.Items[0].ID != sub.ID || list.Items[0].UserEmail != "ana@example.com" || list.Items[0].Payload == nil {
		t.Fatalf("admin view (oldest pending first, with submitter + payload): %+v", list.Items[0])
	}
	if code, _ := reviewReq(t, app, "GET", "/api/admin/ports/submissions?status=weird", adminTok, nil); code != 400 {
		t.Fatalf("bad status: %d", code)
	}

	// community is empty before approval
	code, body = reviewReq(t, app, "GET", "/api/ports/community", "", nil)
	if code != 200 || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("community empty: %d %s", code, body)
	}

	// edit-then-approve: id clashing with the catalog is refused, then a valid edit is published
	edited := validPortSub()
	edited["id"] = "soh"
	if code, body := reviewReq(t, app, "POST", "/api/admin/ports/submissions/"+strconv.Itoa(int(sub.ID))+"/approve", adminTok, map[string]any{"payload": edited}); code != 409 {
		t.Fatalf("approve clash: %d %s", code, body)
	}
	edited["id"] = "mm-recomp"
	edited["description"] = "Editado pelo admin"
	code, body = reviewReq(t, app, "POST", "/api/admin/ports/submissions/"+strconv.Itoa(int(sub.ID))+"/approve", adminTok, map[string]any{"payload": edited})
	if code != 200 || !strings.Contains(string(body), `"status":"approved"`) || !strings.Contains(string(body), `"reviewedByEmail":"admin@example.com"`) {
		t.Fatalf("approve: %d %s", code, body)
	}

	// public community list (cache headers + ETag)
	req := httptest.NewRequest("GET", "/api/ports/community", nil)
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Cache-Control"), "max-age=300") || resp.Header.Get("ETag") == "" {
		t.Fatalf("community headers: %d %v", resp.StatusCode, resp.Header)
	}
	var ports []map[string]any
	json.NewDecoder(resp.Body).Decode(&ports)
	resp.Body.Close()
	if len(ports) != 1 || ports[0]["id"] != "mm-recomp" || ports[0]["description"] != "Editado pelo admin" || ports[0]["community"] != true {
		t.Fatalf("community ports: %+v", ports)
	}
	if _, leaked := ports[0]["stats"]; leaked {
		t.Fatalf("non-whitelisted field kept: %+v", ports[0])
	}
	req = httptest.NewRequest("GET", "/api/ports/community", nil)
	req.Header.Set("If-None-Match", resp.Header.Get("ETag"))
	if resp2, _ := app.Test(req, -1); resp2.StatusCode != 304 {
		t.Fatalf("etag revalidation: %d", resp2.StatusCode)
	}

	// approved repo can't be submitted again
	if code, _ := reviewReq(t, app, "POST", "/api/ports/submissions", otherTok, validPortSub()); code != 409 {
		t.Fatalf("approved dup: %d", code)
	}

	// reject needs a reason; rejecting an approved one unpublishes it
	path := "/api/admin/ports/submissions/" + strconv.Itoa(int(sub.ID)) + "/reject"
	if code, _ := reviewReq(t, app, "POST", path, adminTok, map[string]string{"reason": " "}); code != 400 {
		t.Fatalf("reject without reason: %d", code)
	}
	if code, body := reviewReq(t, app, "POST", path, adminTok, map[string]string{"reason": "Link quebrado"}); code != 200 {
		t.Fatalf("reject: %d %s", code, body)
	}
	if _, body := reviewReq(t, app, "GET", "/api/ports/community", "", nil); strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("community after reject: %s", body)
	}
	code, body = reviewReq(t, app, "GET", "/api/ports/submissions/mine", userTok, nil)
	if code != 200 || !strings.Contains(string(body), `"status":"rejected"`) || !strings.Contains(string(body), `"rejectReason":"Link quebrado"`) {
		t.Fatalf("mine after reject: %d %s", code, body)
	}

	// delete
	if code, _ := reviewReq(t, app, "DELETE", "/api/admin/ports/submissions/"+strconv.Itoa(int(sohView.Submission.ID)), adminTok, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := reviewReq(t, app, "DELETE", "/api/admin/ports/submissions/99999", adminTok, nil); code != 404 {
		t.Fatalf("delete missing: %d", code)
	}
}

func TestPortSubmissionRateLimit(t *testing.T) {
	now := time.Now()
	portSubLimiter.Lock()
	portSubLimiter.hits = map[uint][]time.Time{}
	portSubLimiter.Unlock()
	for i := 0; i < portSubPostsPerHour; i++ {
		if !allowPortSubmission(42, now) {
			t.Fatalf("hit %d refused", i)
		}
	}
	if allowPortSubmission(42, now) {
		t.Fatal("limit not enforced")
	}
	if !allowPortSubmission(42, now.Add(portSubPostWindow+time.Second)) {
		t.Fatal("window did not slide")
	}
}

func TestNormalizeGithubRepo(t *testing.T) {
	for in, want := range map[string]string{
		"owner/repo":                              "owner/repo",
		"https://github.com/Owner/Repo.git":       "Owner/Repo",
		"github.com/owner/repo/releases/tag/v1.0": "owner/repo",
		"http://www.github.com/a-b/c.d_e/":        "a-b/c.d_e",
	} {
		got, ok := normalizeGithubRepo(in)
		if !ok || got != want {
			t.Errorf("%q → %q (%v), want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"owner", "https://gitlab.com/a/b", "-bad/repo", "a/b c"} {
		if _, ok := normalizeGithubRepo(in); ok {
			t.Errorf("%q should be invalid", in)
		}
	}
}
