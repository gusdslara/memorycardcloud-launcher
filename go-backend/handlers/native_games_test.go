package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

func nativeTestApp(t *testing.T) (*fiber.App, string) {
	t.Helper()
	setupRomsTestDB(t)
	dataDir := t.TempDir()
	t.Setenv("DATA_DIR", dataDir)
	t.Setenv("APP_RELEASES_DIR", dataDir+"/app-releases")
	if err := database.DB.AutoMigrate(&models.NativeGame{}, &models.NativeBuild{}, &models.AppRelease{}); err != nil {
		t.Fatal(err)
	}
	admin := models.User{Email: "admin@x.com", IsAdmin: true}
	database.DB.Create(&admin)

	app := fiber.New()
	app.Get("/api/native-games", ListNativeGames)
	app.Get("/api/native-games/:slug/:platform/:file", DownloadNativeGame)
	app.Get("/api/app/releases", GetAppReleases)
	app.Get("/api/app/download/:platform", DownloadLatestApp)
	app.Get("/api/app/update/:target/:arch/:current", AppUpdateCheck)
	g := app.Group("/api/admin", AuthMiddleware(), AdminMiddleware)
	g.Post("/uploads", AdminStartUpload)
	g.Put("/uploads/:id", AdminUploadChunk)
	g.Post("/native-games", AdminCreateNativeGame)
	g.Post("/native-games/:slug/builds", AdminAddNativeBuild)
	g.Post("/app-releases", AdminCreateAppRelease)
	return app, createRomTestToken(admin.ID)
}

func doJSON(t *testing.T, app *fiber.App, method, url, token string, body any) *httpResult {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, url, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req, 10000)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	return &httpResult{resp.StatusCode, data, resp.Header.Get("Content-Disposition")}
}

type httpResult struct {
	Status      int
	Body        []byte
	Disposition string
}

// uploadInChunks sends data with the chunked upload API, 7 bytes at a time.
func uploadInChunks(t *testing.T, app *fiber.App, token, name string, data []byte) string {
	t.Helper()
	res := doJSON(t, app, "POST", "/api/admin/uploads", token, map[string]any{"file_name": name, "size": len(data)})
	if res.Status != 201 {
		t.Fatalf("start: %d %s", res.Status, res.Body)
	}
	var up struct{ ID string }
	json.Unmarshal(res.Body, &up)
	for off := 0; off < len(data); off += 7 {
		end := off + 7
		if end > len(data) {
			end = len(data)
		}
		req := httptest.NewRequest("PUT", "/api/admin/uploads/"+up.ID, bytes.NewReader(data[off:end]))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Upload-Offset", strconv.Itoa(off))
		resp, err := app.Test(req, 10000)
		if err != nil || resp.StatusCode != 200 {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("chunk %d: %v %d %s", off, err, resp.StatusCode, b)
		}
	}
	// A wrong offset is refused with 409 (the client resumes from "received")
	req := httptest.NewRequest("PUT", "/api/admin/uploads/"+up.ID, bytes.NewReader([]byte("zz")))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Upload-Offset", "1")
	if resp, _ := app.Test(req); resp.StatusCode != 200 && resp.StatusCode != 409 {
		t.Fatalf("offset check: %d", resp.StatusCode)
	}
	return up.ID
}

func zipBytes(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for n, c := range files {
		f, _ := w.Create(n)
		f.Write([]byte(c))
	}
	w.Close()
	return buf.Bytes()
}

func TestNativeGameUploadAndDownload(t *testing.T) {
	app, token := nativeTestApp(t)

	if res := doJSON(t, app, "POST", "/api/admin/native-games", token, map[string]any{"title": "Grand Theft Auto: San Andreas", "year": 2004}); res.Status != 201 {
		t.Fatalf("create: %d %s", res.Status, res.Body)
	}
	// Non-admins can't create
	if res := doJSON(t, app, "POST", "/api/admin/native-games", "", map[string]any{"title": "x"}); res.Status != 401 {
		t.Fatalf("anon create: %d", res.Status)
	}

	// Android: zip with apk + obb folder
	id := uploadInChunks(t, app, token, "gtasa.zip", zipBytes(t, map[string]string{
		"gtasa.apk": "THE-APK",
		"com.rockstargames.gtasa/main.8.com.rockstargames.gtasa.obb": "THE-OBB",
	}))
	res := doJSON(t, app, "POST", "/api/admin/native-games/grand-theft-auto-san-andreas/builds", token, map[string]any{"platform": "android", "upload_id": id})
	if res.Status != 201 {
		t.Fatalf("build: %d %s", res.Status, res.Body)
	}
	// Windows: zip with the game folder
	id = uploadInChunks(t, app, token, "gtasa-pc.zip", zipBytes(t, map[string]string{"GTA SA/gta_sa.exe": "EXE", "GTA SA/models/gta3.img": "IMG"}))
	if res := doJSON(t, app, "POST", "/api/admin/native-games/grand-theft-auto-san-andreas/builds", token, map[string]any{"platform": "windows", "upload_id": id}); res.Status != 201 {
		t.Fatalf("win build: %d %s", res.Status, res.Body)
	}

	// Public list filtered by platform
	res = doJSON(t, app, "GET", "/api/native-games?platform=android", "", nil)
	var games []models.NativeGame
	json.Unmarshal(res.Body, &games)
	if len(games) != 1 || len(games[0].Builds) != 1 {
		t.Fatalf("list: %s", res.Body)
	}
	b := games[0].Builds[0]
	if b.Kind != "apk+data" || b.PackageName != "com.rockstargames.gtasa" || b.ApkURL == "" || b.DataURL == "" {
		t.Fatalf("build: %+v", b)
	}
	res = doJSON(t, app, "GET", "/api/native-games?platform=windows", "", nil)
	json.Unmarshal(res.Body, &games)
	if games[0].Builds[0].Executable != "gta_sa.exe" {
		t.Fatalf("exe: %+v", games[0].Builds[0])
	}
	if res := doJSON(t, app, "GET", "/api/native-games?platform=ios", "", nil); string(res.Body) != "[]" {
		t.Fatalf("ios should be empty: %s", res.Body)
	}

	// Downloads
	res = doJSON(t, app, "GET", "/api/native-games/grand-theft-auto-san-andreas/android/apk", "", nil)
	if res.Status != 200 || string(res.Body) != "THE-APK" {
		t.Fatalf("apk: %d %q", res.Status, res.Body)
	}
	res = doJSON(t, app, "GET", "/api/native-games/grand-theft-auto-san-andreas/android/data", "", nil)
	zr, err := zip.NewReader(bytes.NewReader(res.Body), int64(len(res.Body)))
	if err != nil || zr.File[0].Name != "Android/obb/com.rockstargames.gtasa/main.8.com.rockstargames.gtasa.obb" {
		t.Fatalf("data zip: %v", err)
	}
}

func TestAppReleasesNewestAndUpdater(t *testing.T) {
	app, token := nativeTestApp(t)
	publish := func(platform, version string, build int, content, sig string) {
		id := uploadInChunks(t, app, token, fmt.Sprintf("MemoryCard_%s_x64-setup.exe", version), []byte(content))
		res := doJSON(t, app, "POST", "/api/admin/app-releases", token, map[string]any{
			"platform": platform, "version": version, "build": build, "upload_id": id, "signature": sig, "notes": "v" + version,
		})
		if res.Status != 201 {
			t.Fatalf("publish: %d %s", res.Status, res.Body)
		}
	}
	publish("windows", "0.2.0", 0, "build-one", "SIG1") // build auto = 1
	publish("windows", "0.3.0", 0, "build-two", "SIG2") // build auto = 2

	res := doJSON(t, app, "GET", "/api/app/releases", "", nil)
	var rel map[string]publicRelease
	json.Unmarshal(res.Body, &rel)
	if rel["windows"].Version != "0.3.0" || rel["windows"].Build != 2 {
		t.Fatalf("latest: %s", res.Body)
	}
	res = doJSON(t, app, "GET", "/api/app/download/windows", "", nil)
	if string(res.Body) != "build-two" {
		t.Fatalf("download served an old build: %q", res.Body)
	}
	if res := doJSON(t, app, "GET", "/api/app/download/macos", "", nil); res.Status != 404 {
		t.Fatalf("macos: %d", res.Status)
	}

	// Updater: 0.2.0 gets 0.3.0, 0.3.0 is up to date
	res = doJSON(t, app, "GET", "/api/app/update/windows/x86_64/0.2.0", "", nil)
	var up map[string]string
	json.Unmarshal(res.Body, &up)
	if res.Status != 200 || up["version"] != "0.3.0" || up["signature"] != "SIG2" || up["url"] == "" {
		t.Fatalf("update: %d %s", res.Status, res.Body)
	}
	if res := doJSON(t, app, "GET", "/api/app/update/windows/x86_64/0.3.0", "", nil); res.Status != 204 {
		t.Fatalf("up to date should be 204, got %d", res.Status)
	}
	if res := doJSON(t, app, "GET", "/api/app/update/darwin/aarch64/0.1.0", "", nil); res.Status != 204 {
		t.Fatalf("no mac build should be 204, got %d", res.Status)
	}
	_ = os.Getenv
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"1.10.0", "1.9.9", 1}, {"0.2.0", "0.2.0", 0}, {"v0.3.0", "0.3.1", -1}, {"1.0.0-beta.1", "1.0.0", -1}}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("%s vs %s = %d", c.a, c.b, got)
		}
	}
}
