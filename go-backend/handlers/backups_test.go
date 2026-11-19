package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/internal/backupstore"
	"go-backend/internal/gdrive"
	"go-backend/internal/gdrive/gdrivetest"
	"go-backend/models"

	"github.com/glebarez/sqlite"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const mb = int64(1 << 20)

type backupEnv struct {
	t    *testing.T
	app  *fiber.App
	fake *gdrivetest.Server
	svc  *backupstore.Service
	cfg  backupstore.Config
}

func setupBackups(t *testing.T, driveConnected bool, tweak func(*backupstore.Config)) *backupEnv {
	t.Helper()
	t.Setenv("JWT_SECRET", "testsecret1234567890123456789012")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "backups.db")+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	database.DB = db
	models.PlanStorageResolver = nil
	if err := db.AutoMigrate(&models.User{}, &models.Plan{}, &models.Game{}, &models.GoogleDriveConfig{}); err != nil {
		t.Fatal(err)
	}
	if err := backupstore.Migrate(); err != nil {
		t.Fatal(err)
	}
	fake := gdrivetest.Start(t)
	if driveConnected {
		db.Create(&models.GoogleDriveConfig{OAuthRefreshToken: "rt-owner", AuthType: "oauth"})
	}
	cfg := backupstore.Config{
		Backend: "auto", DataDir: t.TempDir(), RootName: "MemoryCard Backups", DailyUploadBudget: 1 << 40,
		ReserveRatio: 0.1, GracePeriod: 30 * 24 * time.Hour, Workers: 1, JanitorEvery: time.Hour,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	svc := backupstore.New(cfg)
	backupstore.SetDefault(svc)
	t.Cleanup(func() { backupstore.SetDefault(nil) })

	app := fiber.New(fiber.Config{BodyLimit: 64 << 20})
	app.Get("/api/saves", GetSaves)
	app.Post("/api/saves", UploadSave)
	app.Post("/api/upload/backup", UploadBackup)
	app.Get("/api/saves/:id/download", DownloadSave)
	app.Delete("/api/saves/:id", DeleteSave)
	RegisterBackupRoutes(app, nil)
	return &backupEnv{t: t, app: app, fake: fake, svc: svc, cfg: cfg}
}

func (e *backupEnv) user(email, tier string, limit int64) (models.User, string) {
	e.t.Helper()
	exp := time.Now().Add(30 * 24 * time.Hour)
	u := models.User{Email: email, SubscriptionStatus: "active", SubscriptionPlan: tier, StorageLimit: limit, SubscriptionExpiresAt: &exp}
	if tier == "none" {
		u.SubscriptionStatus, u.SubscriptionExpiresAt = "inactive", nil
	}
	if err := database.DB.Create(&u).Error; err != nil {
		e.t.Fatal(err)
	}
	return u, createRomTestToken(u.ID)
}

func (e *backupEnv) do(token, method, path string, body io.Reader, hdr map[string]string) (*http.Response, []byte) {
	e.t.Helper()
	req := httptest.NewRequest(method, path, body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := e.app.Test(req, 60000)
	if err != nil {
		e.t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

func randBytes(n int64) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// upload sends data with the chunked API like the app does; returns the HTTP status of the
// failing step (or 200) and the created backup.
func (e *backupEnv) upload(token, game string, data []byte, ts int64) (int, map[string]any) {
	e.t.Helper()
	start, _ := json.Marshal(map[string]any{"file_name": game + ".zip", "size": len(data), "game_name": game, "platform": "PC", "timestamp": ts})
	resp, raw := e.do(token, "POST", "/api/backups/uploads", bytes.NewReader(start), map[string]string{"Content-Type": "application/json"})
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode != 201 {
		return resp.StatusCode, out
	}
	id := out["id"].(string)
	chunk := 300 << 10
	for off := 0; off < len(data); off += chunk {
		end := min(off+chunk, len(data))
		resp, raw = e.do(token, "PUT", "/api/backups/uploads/"+id, bytes.NewReader(data[off:end]),
			map[string]string{"Upload-Offset": strconv.Itoa(off), "Content-Type": "application/octet-stream"})
		if resp.StatusCode != 200 {
			_ = json.Unmarshal(raw, &out)
			return resp.StatusCode, out
		}
	}
	resp, raw = e.do(token, "POST", "/api/backups/uploads/"+id+"/complete", nil, nil)
	out = map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func (e *backupEnv) drain() {
	for e.svc.ProcessOne(context.Background()) {
	}
}

func (e *backupEnv) download(token string, id any, rng string) (int, []byte) {
	hdr := map[string]string{}
	if rng != "" {
		hdr["Range"] = rng
	}
	resp, raw := e.do(token, "GET", fmt.Sprintf("/api/saves/%v/download", id), nil, hdr)
	return resp.StatusCode, raw
}

func (e *backupEnv) usage(token string) backupstore.Usage {
	_, raw := e.do(token, "GET", "/api/backups/usage", nil, nil)
	var u backupstore.Usage
	_ = json.Unmarshal(raw, &u)
	return u
}

func TestBackupsEndToEndOnOwnerDrive(t *testing.T) {
	e := setupBackups(t, true, nil)
	alice, ta := e.user("alice@example.com", "silver", 3*mb)
	_, tb := e.user("bob@example.com", "gold", 10*mb)

	// 1. Chunked upload → queued in staging → worker sends it to Alice's folder in the Drive.
	data := randBytes(mb + 777)
	code, save := e.upload(ta, "Zelda", data, 1000)
	if code != 200 || save["status"] != "queued" {
		t.Fatalf("upload: %d %v", code, save)
	}
	if code, got := e.download(ta, save["ID"], ""); code != 200 || !bytes.Equal(got, data) {
		t.Fatalf("download while queued (staging): %d", code)
	}
	e.drain()
	var blob models.BackupBlob
	database.DB.First(&blob)
	if blob.Status != models.BlobStored || blob.Backend != models.BackendDrive || blob.StagingPath != "" {
		t.Fatalf("blob not stored in the Drive: %+v", blob)
	}
	if f := e.fake.Get(blob.DriveFileID); f == nil || !bytes.Equal(f.Data, data) {
		t.Fatal("bytes in the Drive differ")
	}
	userFolder := e.fake.ByName(fmt.Sprintf("u%d", alice.ID))
	users := e.fake.ByName("users")
	root := e.fake.ByName("MemoryCard Backups")
	if userFolder == nil || users == nil || root == nil || userFolder.Parents[0] != users.ID || users.Parents[0] != root.ID {
		t.Fatal("Drive layout MemoryCard Backups/users/u<ID> not created")
	}
	if e.fake.Get(blob.DriveFileID).Parents[0] != userFolder.ID {
		t.Fatal("file is not in the user's folder")
	}
	if code, got := e.download(ta, save["ID"], "bytes=5-14"); code != 206 || !bytes.Equal(got, data[5:15]) {
		t.Fatalf("range download from the Drive: %d", code)
	}
	// Signed link (site): works without the Authorization header, only for the owner's backup.
	_, raw := e.do(ta, "GET", fmt.Sprintf("/api/backups/%v/link", save["ID"]), nil, nil)
	var link struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(raw, &link)
	if resp, got := e.do("", "GET", link.URL, nil, nil); resp.StatusCode != 200 || !bytes.Equal(got, data) {
		t.Fatalf("signed link: %d %q", resp.StatusCode, link.URL)
	}
	if resp, _ := e.do("", "GET", link.URL+"x", nil, nil); resp.StatusCode != 410 {
		t.Fatalf("tampered link: %d", resp.StatusCode)
	}
	if resp, _ := e.do(tb, "GET", fmt.Sprintf("/api/backups/%v/link", save["ID"]), nil, nil); resp.StatusCode != 404 {
		t.Fatalf("link for someone else's backup: %d", resp.StatusCode)
	}
	if code, _ := e.download(tb, save["ID"], ""); code != 404 {
		t.Fatalf("Bob must not read Alice's backup: %d", code)
	}

	// 2. Quota before the upload: 1 MB used of 3 MB, 2.5 MB does not fit (nothing is received).
	u := e.usage(ta)
	if u.Used != int64(len(data)) || u.Limit != 3*mb || !u.CanUpload {
		t.Fatalf("usage: %+v", u)
	}
	if code, out := e.upload(ta, "Big", randBytes(5*mb/2), 1001); code != 507 || out["code"] != "QUOTA_EXCEEDED" {
		t.Fatalf("expected 507 QUOTA_EXCEEDED, got %d %v", code, out)
	}

	// 3. Quota during the upload: chunks past the reserved size are refused; the reservation counts.
	start, _ := json.Marshal(map[string]any{"file_name": "x.zip", "size": mb, "game_name": "X"})
	resp, raw := e.do(ta, "POST", "/api/backups/uploads", bytes.NewReader(start), map[string]string{"Content-Type": "application/json"})
	var st backupstore.SessionState
	_ = json.Unmarshal(raw, &st)
	if resp.StatusCode != 201 {
		t.Fatalf("start: %d %s", resp.StatusCode, raw)
	}
	if r := e.usage(ta).Reserved; r != mb {
		t.Fatalf("reservation not counted: %d", r)
	}
	resp, _ = e.do(ta, "PUT", "/api/backups/uploads/"+st.ID, bytes.NewReader(randBytes(mb+1)), map[string]string{"Upload-Offset": "0"})
	if resp.StatusCode != 413 {
		t.Fatalf("oversized chunk: %d", resp.StatusCode)
	}
	resp, raw = e.do(ta, "POST", "/api/backups/uploads/"+st.ID+"/complete", nil, nil)
	if resp.StatusCode != 409 {
		t.Fatalf("completing an incomplete upload: %d %s", resp.StatusCode, raw)
	}
	e.do(ta, "DELETE", "/api/backups/uploads/"+st.ID, nil, nil)
	if r := e.usage(ta).Reserved; r != 0 {
		t.Fatalf("cancel did not release the reservation: %d", r)
	}

	// 4. Dedup: Bob sends the same bytes → no new Drive upload, the file moves to "shared".
	uploadsBefore := e.fake.Count("session")
	code, bsave := e.upload(tb, "Zelda", data, 2000)
	if code != 200 || bsave["status"] != "stored" {
		t.Fatalf("dedup upload: %d %v", code, bsave)
	}
	e.drain()
	if e.fake.Count("session") != uploadsBefore {
		t.Fatal("dedup re-uploaded the bytes")
	}
	var nblobs int64
	database.DB.Model(&models.BackupBlob{}).Count(&nblobs)
	if nblobs != 1 {
		t.Fatalf("expected 1 blob, got %d", nblobs)
	}
	e.svc.Janitor(context.Background())
	shared := e.fake.ByName("shared")
	if shared == nil || e.fake.Get(blob.DriveFileID).Parents[0] != shared.ID {
		t.Fatal("shared blob was not moved to the shared folder")
	}
	if u := e.usage(tb); u.Used != int64(len(data)) {
		t.Fatalf("Bob must be charged the full size: %+v", u)
	}

	// 5. Alice deletes: Bob still has the bytes. Bob deletes: the Drive file goes.
	if resp, _ := e.do(ta, "DELETE", fmt.Sprintf("/api/saves/%v", save["ID"]), nil, nil); resp.StatusCode != 200 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if code, got := e.download(tb, bsave["ID"], ""); code != 200 || !bytes.Equal(got, data) {
		t.Fatal("Bob lost his copy when Alice deleted hers")
	}
	e.do(tb, "DELETE", fmt.Sprintf("/api/saves/%v", bsave["ID"]), nil, nil)
	if e.fake.Get(blob.DriveFileID) != nil {
		t.Fatal("Drive file not deleted when nobody uses it")
	}
	// Empty user folder is removed (LGPD: nothing of the user stays in the Drive).
	e.svc.Janitor(context.Background())
	if e.fake.ByName(fmt.Sprintf("u%d", alice.ID)) != nil {
		t.Fatal("empty user folder kept")
	}
}

func TestBackupsMultipartRoutesPlanAndRetention(t *testing.T) {
	e := setupBackups(t, true, nil)
	_, tok := e.user("carol@example.com", "silver", 50*mb)
	_, free := e.user("free@example.com", "none", 0)

	send := func(token, path string, data []byte, ts int) (int, map[string]any) {
		var body bytes.Buffer
		w := multipart.NewWriter(&body)
		_ = w.WriteField("game_name", "Mario")
		_ = w.WriteField("timestamp", strconv.Itoa(ts))
		_ = w.WriteField("hash", fmt.Sprintf("h%d", ts))
		fw, _ := w.CreateFormFile("file", fmt.Sprintf("Mario_%d.zip", ts))
		_, _ = fw.Write(data)
		_ = w.Close()
		resp, raw := e.do(token, "POST", path, &body, map[string]string{"Content-Type": w.FormDataContentType()})
		out := map[string]any{}
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out
	}
	if code, out := send(free, "/api/upload/backup", []byte("x"), 1); code != 403 || out["code"] != "PLAN_REQUIRED" {
		t.Fatalf("no plan: %d %v", code, out)
	}
	// Silver keeps 5 versions per game: the 2 oldest of 7 are pruned (and their bytes).
	for i := 1; i <= 7; i++ {
		path := "/api/upload/backup"
		if i%2 == 0 {
			path = "/api/saves" // the site's route
		}
		if code, out := send(tok, path, randBytes(1000+int64(i)), i); code != 200 {
			t.Fatalf("upload %d: %d %v", i, code, out)
		}
	}
	e.drain()
	_, raw := e.do(tok, "GET", "/api/saves", nil, nil)
	var list []models.GameSave
	_ = json.Unmarshal(raw, &list)
	if len(list) != 5 || list[0].Timestamp != 7 || list[4].Timestamp != 3 {
		t.Fatalf("retention: %d saves %+v", len(list), list)
	}
	if list[0].Filename != "" || list[0].Status != "stored" {
		t.Fatalf("list leaks server paths or wrong status: %+v", list[0])
	}
	var blobs int64
	database.DB.Model(&models.BackupBlob{}).Count(&blobs)
	if blobs != 5 || e.fake.FileCount("file") != 5 {
		t.Fatalf("pruned versions still stored: %d blobs, %d Drive files", blobs, e.fake.FileCount("file"))
	}
}

func TestBackupsDowngradeGraceAndPurge(t *testing.T) {
	e := setupBackups(t, true, nil)
	u, tok := e.user("dave@example.com", "gold", 10*mb)
	for i, game := range []string{"A", "A", "B", "C"} {
		if code, out := e.upload(tok, game, randBytes(mb), int64(100+i)); code != 200 {
			t.Fatalf("upload: %d %v", code, out)
		}
	}
	e.drain()

	// Downgrade to 2 MB: over quota, uploads blocked, grace starts — nothing deleted yet.
	database.DB.Model(&models.User{}).Where("id = ?", u.ID).Updates(map[string]any{"subscription_plan": "silver", "storage_limit": 2 * mb})
	e.svc.Janitor(context.Background())
	us := e.usage(tok)
	if !us.OverQuota || us.GraceUntil == nil || us.CanUpload {
		t.Fatalf("over quota not reported: %+v", us)
	}
	if code, out := e.upload(tok, "D", randBytes(10), 200); code != 507 || out["over_quota"] != true {
		t.Fatalf("upload while over quota: %d %v", code, out)
	}
	var n int64
	database.DB.Model(&models.GameSave{}).Where("user_id = ?", u.ID).Count(&n)
	if n != 4 {
		t.Fatalf("deleted during the grace period: %d left", n)
	}

	// Grace over: old versions go first (A@100), then the oldest latest versions (A@101, B@102).
	past := time.Now().Add(-31 * 24 * time.Hour)
	database.DB.Model(&models.BackupAccount{}).Where("user_id = ?", u.ID).Update("over_quota_since", past)
	e.svc.Janitor(context.Background())
	var left []models.GameSave
	database.DB.Where("user_id = ?", u.ID).Order("timestamp").Find(&left)
	if len(left) != 2 || left[0].GameName != "B" || left[1].GameName != "C" {
		t.Fatalf("purge order wrong: %+v", left)
	}
	if e.usage(tok).OverQuota {
		t.Fatal("still over quota after the purge")
	}
	if e.fake.FileCount("file") != 2 {
		t.Fatalf("purged bytes still in the Drive: %d files", e.fake.FileCount("file"))
	}

	// Cancelled plan + account deleted: everything goes (LGPD).
	database.DB.Delete(&models.User{}, u.ID)
	e.svc.Janitor(context.Background())
	e.svc.Janitor(context.Background())
	if e.fake.FileCount("file") != 0 || e.fake.ByName(fmt.Sprintf("u%d", u.ID)) != nil {
		t.Fatalf("deleted account left data in the Drive: %d files", e.fake.FileCount("file"))
	}
}

func TestBackupsDailyBudgetAndLocalFallback(t *testing.T) {
	// Drive not connected yet: backups are kept on the server disk.
	e := setupBackups(t, false, func(c *backupstore.Config) { c.DailyUploadBudget = 3 * mb / 2 })
	_, tok := e.user("erin@example.com", "gold", 20*mb)
	d1, d2 := randBytes(mb), randBytes(mb)
	if code, _ := e.upload(tok, "A", d1, 1); code != 200 {
		t.Fatal(code)
	}
	e.drain()
	var b models.BackupBlob
	database.DB.First(&b)
	if b.Backend != models.BackendLocal || b.Status != models.BlobStored {
		t.Fatalf("local fallback: %+v", b)
	}

	// The owner connects the Drive: the local copy is promoted and sent, the disk is freed.
	database.DB.Create(&models.GoogleDriveConfig{OAuthRefreshToken: "rt-owner", AuthType: "oauth"})
	e.svc.Janitor(context.Background())
	e.drain()
	database.DB.First(&b, b.ID)
	if b.Backend != models.BackendDrive || b.LocalPath != "" {
		t.Fatalf("promotion to the Drive: %+v", b)
	}
	// 1 MB sent today; the budget is 1.5 MB → the second file waits for the next window.
	if code, _ := e.upload(tok, "B", d2, 2); code != 200 {
		t.Fatal(code)
	}
	e.drain()
	var q models.BackupBlob
	database.DB.Where("status <> ?", models.BlobStored).First(&q)
	if q.ID == 0 || !q.NextTryAt.After(time.Now().Add(23*time.Hour)) {
		t.Fatalf("budget not enforced: %+v", q)
	}
	// Still downloadable from staging meanwhile.
	_, raw := e.do(tok, "GET", "/api/saves", nil, nil)
	var list []models.GameSave
	_ = json.Unmarshal(raw, &list)
	if code, got := e.download(tok, list[0].ID, ""); code != 200 || !bytes.Equal(got, d2) {
		t.Fatalf("queued download: %d", code)
	}
	if code, got := e.download(tok, list[0].ID, "bytes=3-9"); code != 206 || !bytes.Equal(got, d2[3:10]) {
		t.Fatalf("queued range download: %d", code)
	}
	if _, err := os.Stat(q.StagingPath); err != nil {
		t.Fatal("staging file missing")
	}
	st := e.svc.Stats(context.Background())
	if st.QueuedFiles != 1 || st.Uploaded24h != mb || st.LogicalBytes != 2*mb {
		t.Fatalf("stats: %+v", st)
	}
	_ = gdrive.ChunkSize
}
