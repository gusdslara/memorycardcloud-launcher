package gdrive

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"go-backend/models"
)

// fakeDrive: roms/{PS2/God of War II.iso, Nintendo 64/Zelda MM (USA).z64, Nintendo 64/Hacks/x.z64, BIOS/scph39001.bin, notes.txt}
func fakeDrive(t *testing.T) *httptest.Server {
	t.Helper()
	children := map[string][]driveFile{
		"roms": {
			{ID: "ps2", Name: "PS2", MimeType: folderMime},
			{ID: "n64", Name: "Nintendo 64", MimeType: folderMime},
			{ID: "bios", Name: "BIOS", MimeType: folderMime},
			{ID: "notes", Name: "leia-me.txt", MimeType: "text/plain", Size: "10"},
		},
		"ps2":   {{ID: "gow", Name: "God of War II (USA).iso", MimeType: "application/octet-stream", Size: "4096", ModifiedTime: "2026-10-01T10:00:00Z"}},
		"n64":   {{ID: "mm", Name: "Zelda MM (USA).z64", MimeType: "application/octet-stream", Size: "32"}, {ID: "hacks", Name: "Hacks", MimeType: folderMime}},
		"hacks": {{ID: "hack1", Name: "x.z64", MimeType: "application/octet-stream", Size: "8"}},
		"bios":  {{ID: "scph", Name: "scph39001.bin", MimeType: "application/octet-stream", Size: "4"}, {ID: "doc", Name: "Notas", MimeType: "application/vnd.google-apps.document"}},
		"root":  {{ID: "roms", Name: "roms", MimeType: folderMime}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt-1" {
			http.Error(w, `{"error":"invalid_grant"}`, 400)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at-1", "expires_in": 3600})
	})
	mux.HandleFunc("/about", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"user":         map[string]any{"emailAddress": "dono@gmail.com"},
			"storageQuota": map[string]any{"limit": "2199023255552", "usage": "1099511627776", "usageInDrive": "1000000000000", "usageInDriveTrash": "5"},
		})
	})
	mux.HandleFunc("/files", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at-1" {
			http.Error(w, "unauthorized", 401)
			return
		}
		q := r.URL.Query().Get("q")
		var out []driveFile
		if strings.Contains(q, "name contains 'rom'") {
			out = children["root"]
		} else {
			m := regexp.MustCompile(`'([^']+)' in parents`).FindStringSubmatch(q)
			if m == nil {
				http.Error(w, "bad q", 400)
				return
			}
			parent := m[1]
			for _, f := range children[parent] {
				if strings.Contains(q, "mimeType='"+folderMime+"'") && f.MimeType != folderMime {
					continue
				}
				out = append(out, f)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"files": out})
	})
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/files/")
		if r.URL.Query().Get("alt") == "media" {
			w.Write([]byte(strings.Repeat("x", 32)))
			return
		}
		mime := folderMime
		if id == "mm" {
			mime = "application/octet-stream"
		}
		json.NewEncoder(w).Encode(driveFile{ID: id, Name: "roms", MimeType: mime})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	TokenEndpoint, DriveAPI = srv.URL+"/token", srv.URL
	os.Setenv("GOOGLE_CLIENT_ID", "cid")
	os.Setenv("GOOGLE_CLIENT_SECRET", "secret")
	return srv
}

func connected() *DriveService {
	return NewDriveService(models.GoogleDriveConfig{OAuthRefreshToken: "rt-1", FolderID: "roms"})
}

func TestScanTreeUsesConsoleFolders(t *testing.T) {
	fakeDrive(t)
	items, err := connected().ScanTree(context.Background(), "roms", 6)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]models.RomItem{}
	for _, it := range items {
		got[it.Name] = it
	}
	if len(items) != 4 {
		t.Fatalf("want 4 files (txt and Google Docs skipped), got %d: %+v", len(items), items)
	}
	if got["God of War II (USA).iso"].Console != "PS2" || got["God of War II (USA).iso"].SizeBytes != 4096 {
		t.Errorf("PS2 folder: %+v", got["God of War II (USA).iso"])
	}
	if got["Zelda MM (USA).z64"].Console != "N64" || got["x.z64"].Console != "N64" || got["x.z64"].FolderPath != "Nintendo 64/Hacks" {
		t.Errorf("Nintendo 64 folder (incl. sub-folder): %+v / %+v", got["Zelda MM (USA).z64"], got["x.z64"])
	}
	if got["scph39001.bin"].Console != "BIOS" {
		t.Errorf("BIOS folder: %+v", got["scph39001.bin"])
	}
}

func TestScanFolderWithGoogleLoginNeverReturnsSamples(t *testing.T) {
	fakeDrive(t)
	items, err := connected().ScanFolder("roms")
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if strings.HasPrefix(it.DriveFileID, "1gDrive_") {
			t.Fatalf("sample catalog leaked into a real sync: %s", it.Name)
		}
	}
}

func TestListFoldersAndSearch(t *testing.T) {
	fakeDrive(t)
	s := connected()
	root, err := s.ListFolders(context.Background(), "root", "")
	if err != nil || len(root) != 1 || root[0].Name != "roms" {
		t.Fatalf("root folders: %+v %v", root, err)
	}
	sub, _ := s.ListFolders(context.Background(), "roms", "")
	if len(sub) != 3 {
		t.Fatalf("roms sub-folders should be only folders, got %+v", sub)
	}
	found, _ := s.ListFolders(context.Background(), "", "rom")
	if len(found) != 1 {
		t.Fatalf("search: %+v", found)
	}
	if _, err := s.FolderName(context.Background(), "mm"); err == nil {
		t.Fatal("a file must not be accepted as the roms folder")
	}
}

func TestDownloadToFileIsAtomic(t *testing.T) {
	fakeDrive(t)
	dest := filepath.Join(t.TempDir(), "N64", "mm.z64")
	var last int64
	n, err := connected().DownloadToFile(context.Background(), "mm", dest, func(b int64) { last = b })
	if err != nil || n != 32 || last != 32 {
		t.Fatalf("download: n=%d last=%d err=%v", n, last, err)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part file left behind")
	}
}

func TestConsoleFromFolder(t *testing.T) {
	cases := map[string]string{
		"PS2": "PS2", "PlayStation 2": "PS2", "psx": "PS1", "Nintendo 64": "N64", "n64": "N64",
		"GameCube": "GameCube", "Nintendo Switch": "Switch", "Super Nintendo": "SNES", "Mega Drive": "Mega Drive",
		"Bios": "BIOS", "Xbox 360": "Xbox 360", "Arcade": "Arcade",
	}
	for in, want := range cases {
		if got := ConsoleFromFolder(in); got != want {
			t.Errorf("ConsoleFromFolder(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAuthCodeURLAsksOfflineReadOnly(t *testing.T) {
	u := OAuthClient{ClientID: "cid", ClientSecret: "s", RedirectURL: "https://memorycard.cloud/api/gdrive/oauth/callback"}.AuthCodeURL("st", "")
	for _, want := range []string{"access_type=offline", "prompt=consent", "drive.readonly", "state=st", "redirect_uri=https%3A%2F%2Fmemorycard.cloud"} {
		if !strings.Contains(u, want) {
			t.Errorf("auth url missing %q: %s", want, u)
		}
	}
}

func TestStorageQuota(t *testing.T) {
	fakeDrive(t)
	q, err := connected().StorageQuota(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.Email != "dono@gmail.com" || q.Limit != 2<<40 || q.Usage != 1<<40 || q.Free != 1<<40 || q.UsageInDrive != 1000000000000 {
		t.Fatalf("quota: %+v", q)
	}
}
