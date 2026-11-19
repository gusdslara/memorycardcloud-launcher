package gdrive

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"go-backend/models"
)

func file(console, rel, name string, size int64) models.RomItem {
	return models.RomItem{DriveFileID: rel + "/" + name, Name: name, Console: console, Extension: strings.ToLower(pathExt(name)), SizeBytes: size, ConsoleDir: console, RelDir: rel}
}

func games(items []models.RomItem) map[string][]models.RomItem {
	out := map[string][]models.RomItem{}
	for _, it := range items {
		out[it.GameTitle] = append(out[it.GameTitle], it)
	}
	return out
}

func mainOf(g []models.RomItem) string {
	for _, it := range g {
		if it.GameMain {
			return it.GamePath
		}
	}
	return ""
}

func TestDetectGamesLooseAndFolders(t *testing.T) {
	items := []models.RomItem{
		// loose cue+bin set and a loose single-file game in the PS1 folder
		file("PS1", "", "Crash Bandicoot (USA).cue", 1),
		file("PS1", "", "Crash Bandicoot (USA) (Track 1).bin", 500),
		file("PS1", "", "Crash Bandicoot (USA) (Track 2).bin", 20),
		file("PS1", "", "Tekken 3 (USA).chd", 400),
		// multi-disc game in its own folder
		file("PS1", "Final Fantasy VII", "Final Fantasy VII (USA) (Disc 1).cue", 1),
		file("PS1", "Final Fantasy VII", "Final Fantasy VII (USA) (Disc 1).bin", 700),
		file("PS1", "Final Fantasy VII", "Final Fantasy VII (USA) (Disc 2).cue", 1),
		file("PS1", "Final Fantasy VII", "Final Fantasy VII (USA) (Disc 2).bin", 700),
		// game folder whose bins have no game name
		file("PS1", "Spyro", "Spyro.cue", 1),
		file("PS1", "Spyro", "Track 01.bin", 600),
		file("PS1", "Spyro", "Track 02.bin", 30),
		file("PS1", "Spyro", "cover.jpg", 3),
		// category folder: two loose games inside
		file("PS1", "Traduzidos", "Silent Hill (PT-BR).bin", 600),
		file("PS1", "Traduzidos", "Silent Hill (PT-BR).cue", 1),
		file("PS1", "Traduzidos", "Resident Evil 2 (PT-BR).chd", 600),
		// extracted PS3 game
		file("PS3", "God of War III", "PS3_DISC.SFB", 1),
		file("PS3", "God of War III/PS3_GAME", "PARAM.SFO", 1),
		file("PS3", "God of War III/PS3_GAME/USRDIR", "EBOOT.BIN", 90),
	}
	DetectGames(items, LayoutAuto)
	g := games(items)

	crash := g["Crash Bandicoot (USA)"]
	if len(crash) != 3 || crash[0].GameFolder || crash[0].GameParts != 3 || mainOf(crash) != "Crash Bandicoot (USA).cue" {
		t.Errorf("loose cue+bin should be one game opened by the .cue: %+v", crash)
	}
	if len(g["Tekken 3 (USA)"]) != 1 {
		t.Errorf("loose single file: %+v", g["Tekken 3 (USA)"])
	}
	ff := g["Final Fantasy VII"]
	if len(ff) != 4 || !ff[0].GameFolder || mainOf(ff) != "Final Fantasy VII (USA) (Disc 1).cue" {
		t.Errorf("multi-disc folder should be one folder game: %+v", ff)
	}
	spyro := g["Spyro"]
	if len(spyro) != 4 || !spyro[0].GameFolder || mainOf(spyro) != "Spyro.cue" {
		t.Errorf("Spyro folder (Track 01.bin + cue + cover): %+v", spyro)
	}
	if len(g["Traduzidos"]) != 0 {
		t.Errorf("category folder must not become a game")
	}
	sh := g["Silent Hill (PT-BR)"]
	if len(sh) != 2 || sh[0].GameFolder || sh[0].GameKey == g["Resident Evil 2 (PT-BR)"][0].GameKey {
		t.Errorf("games inside a category folder stay loose: %+v", sh)
	}
	gow := g["God of War III"]
	if len(gow) != 3 || !gow[0].GameFolder || mainOf(gow) != "PS3_GAME/USRDIR/EBOOT.BIN" {
		t.Errorf("extracted PS3 game: %+v", gow)
	}
	for _, it := range gow {
		if it.Name == "PARAM.SFO" && it.GamePath != "PS3_GAME/PARAM.SFO" {
			t.Errorf("game path keeps the inner structure: %q", it.GamePath)
		}
	}
}

func TestDetectGamesLayoutOverrides(t *testing.T) {
	base := func() []models.RomItem {
		return []models.RomItem{
			file("N64", "Hacks", "Mario Star Road.z64", 8),
			file("N64", "Hacks", "Zelda Master Quest.z64", 8),
			file("N64", "", "Mario Kart 64.z64", 8),
		}
	}
	items := base()
	DetectGames(items, LayoutFolders)
	if g := games(items); len(g["Hacks"]) != 2 || !g["Hacks"][0].GameFolder {
		t.Errorf("layout folders: every sub-folder is a game: %+v", g)
	}
	items = base()
	DetectGames(items, LayoutLoose)
	if g := games(items); len(g["Hacks"]) != 0 || len(g["Mario Star Road"]) != 1 || len(g) != 3 {
		t.Errorf("layout loose: each file is a game: %+v", g)
	}
	items = base()
	DetectGames(items, LayoutAuto)
	if g := games(items); len(g) != 3 {
		t.Errorf("auto: Hacks/ is a category: %+v", g)
	}
}

func TestStemAndTitles(t *testing.T) {
	cases := map[string]string{
		"Metal Gear Solid (USA) (Disc 2).bin":   "metal gear solid (usa)",
		"Metal Gear Solid (USA) (Track 03).bin": "metal gear solid (usa)",
		"Gran Turismo 2 - CD1.iso":              "gran turismo 2",
		"Game.7z.001":                           "game",
		"Track 12.bin":                          "",
	}
	for in, want := range cases {
		if got, _ := stem(in); got != want {
			t.Errorf("stem(%q) = %q, want %q", in, got, want)
		}
	}
	if CleanTitle("Final Fantasy IX [Disc 1]") != "Final Fantasy IX" {
		t.Errorf("CleanTitle: %q", CleanTitle("Final Fantasy IX [Disc 1]"))
	}
}

// Drive: lib/{PSX/(Crash.cue, Crash (Track 1).bin), Esposa/(MGS/MGS.cue, MGS.bin)}, esposa folder mapped elsewhere.
func TestScanSourceFixedConsoleAndSkip(t *testing.T) {
	children := map[string][]driveFile{
		"lib":    {{ID: "psx", Name: "PSX", MimeType: folderMime}, {ID: "esposa", Name: "Esposa", MimeType: folderMime}},
		"psx":    {{ID: "c1", Name: "Crash.cue", Size: "1"}, {ID: "c2", Name: "Crash (Track 1).bin", Size: "9"}},
		"esposa": {{ID: "mgs", Name: "MGS", MimeType: folderMime}},
		"mgs":    {{ID: "m1", Name: "MGS.cue", Size: "1"}, {ID: "m2", Name: "MGS.bin", Size: "9"}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at-1", "expires_in": 3600})
	})
	mux.HandleFunc("/files", func(w http.ResponseWriter, r *http.Request) {
		m := regexp.MustCompile(`'([^']+)' in parents`).FindStringSubmatch(r.URL.Query().Get("q"))
		json.NewEncoder(w).Encode(map[string]any{"files": children[m[1]]})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	TokenEndpoint, DriveAPI = srv.URL+"/token", srv.URL
	os.Setenv("GOOGLE_CLIENT_ID", "cid")
	os.Setenv("GOOGLE_CLIENT_SECRET", "secret")
	s := NewDriveService(models.GoogleDriveConfig{OAuthRefreshToken: "rt-1"})

	auto, err := s.ScanSource(context.Background(), "lib", ScanOptions{Skip: map[string]bool{"esposa": true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(auto) != 2 || auto[0].Console != "PS1" || auto[0].GameKey != auto[1].GameKey {
		t.Fatalf("automatic folder: PSX → PS1, Esposa skipped, cue+bin one game: %+v", auto)
	}

	wife, err := s.ScanSource(context.Background(), "esposa", ScanOptions{Console: "PS1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(wife) != 2 || wife[0].Console != "PS1" || !wife[0].GameFolder || wife[0].GameTitle != "MGS" {
		t.Fatalf("folder mapped to PS1 with a game folder inside: %+v", wife)
	}

	sum := Summarize(append(auto, wife...), 5)
	if len(sum) != 1 || sum[0].Games != 2 || sum[0].FolderGames != 1 || sum[0].LooseGames != 1 {
		t.Fatalf("summary: %+v", sum)
	}
}

func TestKnownConsole(t *testing.T) {
	for _, n := range []string{"PS2", "Playstation 1", "Nintendo 64", "Wii U", "bios"} {
		if _, ok := KnownConsole(n); !ok {
			t.Errorf("%q should be recognised", n)
		}
	}
	if _, ok := KnownConsole("Hacks"); ok {
		t.Errorf("Hacks is not a console")
	}
}
