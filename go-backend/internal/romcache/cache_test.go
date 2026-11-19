package romcache

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/models"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

type fakeFile struct{ ID, Name, Mime, Size, Body string }

func setup(t *testing.T) (*Cache, map[string][]fakeFile, *sync.Mutex) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	database.DB = db
	db.AutoMigrate(&models.GoogleDriveConfig{}, &models.RomItem{}, &models.RomSource{})
	db.Create(&models.GoogleDriveConfig{OAuthRefreshToken: "rt", FolderID: "roms", AuthType: "oauth"})

	var mu sync.Mutex
	tree := map[string][]fakeFile{
		"roms": {{ID: "ps2", Name: "PS2", Mime: "application/vnd.google-apps.folder"}, {ID: "n64", Name: "Nintendo 64", Mime: "application/vnd.google-apps.folder"}},
		"ps2":  {{ID: "gow", Name: "God of War.iso", Mime: "application/octet-stream", Size: "6", Body: "ISO123"}},
		"n64":  {{ID: "mm", Name: "Zelda MM (USA).z64", Mime: "application/octet-stream", Size: "3", Body: "Z64"}},
	}
	bodies := func(id string) string {
		for _, fs := range tree {
			for _, f := range fs {
				if f.ID == id {
					return f.Body
				}
			}
		}
		return ""
	}
	parentRE := regexp.MustCompile(`'([^']+)' in parents`)
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "expires_in": 3600})
	})
	mux.HandleFunc("/files", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		m := parentRE.FindStringSubmatch(r.URL.Query().Get("q"))
		var out []map[string]string
		for _, f := range tree[m[1]] {
			out = append(out, map[string]string{"id": f.ID, "name": f.Name, "mimeType": f.Mime, "size": f.Size, "modifiedTime": "2026-10-01T00:00:00Z"})
		}
		json.NewEncoder(w).Encode(map[string]any{"files": out})
	})
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Write([]byte(bodies(strings.TrimPrefix(r.URL.Path, "/files/"))))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	gdrive.TokenEndpoint, gdrive.DriveAPI = srv.URL+"/token", srv.URL
	os.Setenv("GOOGLE_CLIENT_ID", "cid")
	os.Setenv("GOOGLE_CLIENT_SECRET", "cs")

	t.Setenv("ROMS_CACHE_DIR", filepath.Join(t.TempDir(), "cache"))
	t.Setenv("ROMS_CACHE_MAX_GB", "")
	return FromEnv(), tree, &mu
}

func TestSyncMirrorServeAndGC(t *testing.T) {
	c, tree, mu := setup(t)
	ctx := context.Background()

	n, err := c.SyncFromDrive(ctx)
	if err != nil || n != 2 {
		t.Fatalf("sync: n=%d err=%v", n, err)
	}
	var gow models.RomItem
	database.DB.Where("drive_file_id = ?", "gow").First(&gow)
	if gow.Console != "PS2" || gow.FolderPath != "PS2" {
		t.Fatalf("console from folder: %+v", gow)
	}

	c.pass(ctx)
	st := c.Status()
	if st.Cached != 2 || st.Pending != 0 || st.CachedBytes != 9 {
		t.Fatalf("after pass: %+v", st)
	}
	database.DB.Where("drive_file_id = ?", "gow").First(&gow)
	p, ok := c.LocalFile(gow)
	if !ok {
		t.Fatalf("SSD copy missing: %+v", gow)
	}
	if b, _ := os.ReadFile(p); string(b) != "ISO123" {
		t.Fatalf("SSD copy content = %q", b)
	}
	if _, err := os.Stat(filepath.Join(c.Dir(), marker)); err != nil {
		t.Fatal("cache dir should be marked as ours")
	}

	// Removed from Drive → hidden on next sync, SSD copy deleted on next pass.
	mu.Lock()
	tree["ps2"] = nil
	mu.Unlock()
	if _, err := c.SyncFromDrive(ctx); err != nil {
		t.Fatal(err)
	}
	c.pass(ctx)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("copy of a file removed from Drive should be deleted")
	}
	if st := c.Status(); st.Files != 1 || st.Cached != 1 {
		t.Fatalf("after removal: %+v", st)
	}
}

func TestSizeLimitSkips(t *testing.T) {
	c, _, _ := setup(t)
	c.maxBytes = 4 // only the 3-byte z64 fits
	c.SyncFromDrive(context.Background())
	c.pass(context.Background())
	st := c.Status()
	if st.Cached != 1 || st.Skipped != 1 {
		t.Fatalf("limit: %+v", st)
	}
}

func TestNeverSweepsForeignFolder(t *testing.T) {
	c, _, _ := setup(t)
	os.MkdirAll(c.Dir(), 0o755)
	mine := filepath.Join(c.Dir(), "minhas-coisas.txt")
	os.WriteFile(mine, []byte("x"), 0o644)
	c.SyncFromDrive(context.Background())
	c.pass(context.Background())
	if _, err := os.Stat(mine); err != nil {
		t.Fatal("a pre-existing folder must not be swept")
	}
	if st := c.Status(); st.Cached != 2 {
		t.Fatalf("still mirrors into it: %+v", st)
	}
}

func TestNotConnectedDoesNothing(t *testing.T) {
	c, _, _ := setup(t)
	database.DB.Model(&models.GoogleDriveConfig{}).Where("1 = 1").Update("o_auth_refresh_token", "")
	if _, err := c.SyncFromDrive(context.Background()); err == nil {
		t.Fatal("sync without Google login should fail")
	}
}

// roms/ is automatic; roms/Da esposa/ is mapped to PS1 with one game per folder.
func TestSyncSeveralSourcesWithConsoleMapping(t *testing.T) {
	c, tree, mu := setup(t)
	mu.Lock()
	tree["roms"] = append(tree["roms"], fakeFile{ID: "wife", Name: "Da esposa", Mime: "application/vnd.google-apps.folder"})
	tree["wife"] = []fakeFile{{ID: "spyro", Name: "Spyro", Mime: "application/vnd.google-apps.folder"}}
	tree["spyro"] = []fakeFile{
		{ID: "sc", Name: "Spyro.cue", Mime: "application/octet-stream", Size: "1", Body: "C"},
		{ID: "sb", Name: "Track 01.bin", Mime: "application/octet-stream", Size: "2", Body: "BB"},
	}
	mu.Unlock()
	EnsureSources()
	database.DB.Create(&models.RomSource{FolderID: "wife", FolderName: "Da esposa", Console: "PS1", Layout: gdrive.LayoutAuto})

	n, err := c.SyncFromDrive(context.Background())
	if err != nil || n != 4 {
		t.Fatalf("sync: n=%d err=%v", n, err)
	}
	var sc, sb, gow models.RomItem
	database.DB.Where("drive_file_id = ?", "sc").First(&sc)
	database.DB.Where("drive_file_id = ?", "sb").First(&sb)
	database.DB.Where("drive_file_id = ?", "gow").First(&gow)
	if sc.Console != "PS1" || sc.GameKey == "" || sc.GameKey != sb.GameKey || !sc.GameFolder || sc.GameTitle != "Spyro" || !sc.GameMain || sb.GameMain {
		t.Fatalf("mapped folder: %+v / %+v", sc, sb)
	}
	if sc.FolderPath != "Da esposa/Spyro" || sc.SourceID == gow.SourceID {
		t.Fatalf("source and path: %+v", sc)
	}
	if gow.Console != "PS2" || gow.GameParts != 1 || gow.GameFolder {
		t.Fatalf("automatic folder keeps working: %+v", gow)
	}
	var wrong int64
	database.DB.Model(&models.RomItem{}).Where("console = ?", "Da esposa").Count(&wrong)
	if wrong != 0 {
		t.Fatalf("mapped folder must not be read again as a console named after it")
	}
}
