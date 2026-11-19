package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLibretroMirror(t *testing.T) {
	got := libretroMirror("https://raw.githubusercontent.com/libretro-thumbnails/Sega_-_Mega-CD_-_Sega_CD/master/Named_Boxarts/Sonic%20CD%20(USA).png")
	want := "https://thumbnails.libretro.com/Sega%20-%20Mega-CD%20-%20Sega%20CD/Named_Boxarts/Sonic%20CD%20(USA).png"
	if got != want {
		t.Fatalf("libretroMirror = %q, want %q", got, want)
	}
	if libretroMirror("https://example.com/x.png") != "" {
		t.Fatal("non-libretro URL must not be mirrored")
	}
}

func TestArtSearchTitles(t *testing.T) {
	cases := []struct {
		it   Item
		want []string
	}{
		{Item{Kind: "port", ProjectName: "Doom / Doom II / Heretic / Hexen"}, []string{"Doom (video game)", "Doom"}},
		{Item{Kind: "port", ProjectName: "Tomb Raider (1996)"}, []string{"Tomb Raider (1996 video game)", "Tomb Raider (video game)", "Tomb Raider"}},
		{Item{Kind: "port", ProjectName: "Diablo + Hellfire"}, []string{"Diablo (video game)", "Diablo"}},
		{Item{Kind: "port", ProjectName: "Stardew Valley (Stardew Valley Enhanced (PS Vita))"}, []string{"Stardew Valley (video game)", "Stardew Valley"}},
		{Item{Kind: "port", ProjectName: "Age of Wonders (aow-patch)", WikiTitle: "Age of Wonders (video game)"}, []string{"Age of Wonders (video game)"}},
		{Item{Kind: "emulator", Name: "Dolphin"}, []string{"Dolphin"}},
	}
	for _, c := range cases {
		if got := c.it.ArtSearchTitles(); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: got %q, want %q", c.it.ProjectName+c.it.Name, got, c.want)
		}
	}
}

func TestAboutAGame(t *testing.T) {
	for desc, want := range map[string]bool{
		"1996 video game":                     true,
		"":                                    true,
		"Video game franchise":                false,
		"Video game series":                   false,
		"Topics referred to by the same term": false,
		"American media franchise":            false,
		"Fictional character":                 false,
	} {
		if got := aboutAGame(desc); got != want {
			t.Errorf("aboutAGame(%q) = %v, want %v", desc, got, want)
		}
	}
}

func TestWikipediaPageImageSkipsDisambiguationAndFranchises(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := map[string]any{"title": r.URL.Query().Get("titles")}
		switch page["title"] {
		case "Quake":
			page["pageprops"] = map[string]string{"disambiguation": ""}
			page["original"] = map[string]any{"source": "https://upload.wikimedia.org/q.png", "width": 300}
		case "Banjo-Kazooie":
			page["description"] = "Video game franchise"
			page["original"] = map[string]any{"source": "https://upload.wikimedia.org/logo.png", "width": 600}
		case "Quake (video game)":
			page["description"] = "1996 video game"
			page["original"] = map[string]any{"source": "https://upload.wikimedia.org/wikipedia/en/quake.jpg?utm_source=x", "width": 256}
		default:
			page["missing"] = true
		}
		json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": []any{page}}})
	}))
	t.Cleanup(api.Close)
	s.cfg.WikipediaActionAPI = api.URL
	ctx := context.Background()
	if got := s.wikipediaPageImage(ctx, "Quake", true); got != "" {
		t.Errorf("disambiguation page must be skipped, got %q", got)
	}
	if got := s.wikipediaPageImage(ctx, "Banjo-Kazooie", true); got != "" {
		t.Errorf("franchise page must be skipped, got %q", got)
	}
	if got := s.wikipediaPageImage(ctx, "Banjo-Kazooie", false); got == "" {
		t.Error("an explicit wikiTitle is trusted")
	}
	if got := s.wikipediaPageImage(ctx, "Quake (video game)", true); got != "https://upload.wikimedia.org/wikipedia/en/quake.jpg" {
		t.Errorf("game article image (without tracking query) expected, got %q", got)
	}
	if got := s.wikipediaPageImage(ctx, "Nope", true); got != "" {
		t.Errorf("missing page must give nothing, got %q", got)
	}
}

func TestNewCatalogCoverIsPickedUpBeforeMonthlyRevalidation(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	ctx := context.Background()
	s.Refresh(ctx, true)
	it := s.cat.Get("game-port")
	if st := s.state.Images[imageKey(it.ID, "cover")]; st == nil || !strings.HasSuffix(st.SourceURL, "/img/boxart.png") {
		t.Fatalf("initial cover: %+v", st)
	}

	// A new catalog (npm run art:build + export) brings a better cover: used on the next tick, not next month.
	it.Art = &ArtHints{Covers: []ArtRef{{URL: f.srv.URL + "/img/new-boxart.png", Fit: "cover"}, {URL: f.srv.URL + "/img/boxart.png", Fit: "cover"}}}
	now := time.Now().Add(time.Hour)
	if !s.refreshImage(ctx, it, "cover", now) {
		t.Fatal("changed preferred cover should be refreshed right away")
	}
	st := s.state.Images[imageKey(it.ID, "cover")]
	if !strings.HasSuffix(st.SourceURL, "/img/new-boxart.png") || st.Preferred != f.srv.URL+"/img/new-boxart.png" {
		t.Fatalf("new cover not used: %+v", st)
	}
	if s.refreshImage(ctx, it, "cover", now.Add(time.Minute)) {
		t.Fatal("nothing changed: must not refresh again before the interval")
	}
}

func TestLazyLookupsAreSkippedWhenCuratedCoverWorks(t *testing.T) {
	f := newFakeUpstream(t)
	s := testService(t, f)
	it := s.cat.Get("game-port")
	cands := s.discoverImage(context.Background(), it, "cover")
	if len(cands) == 0 || cands[0].Source != "curated" || cands[0].URL == "" {
		t.Fatalf("curated cover must come first: %+v", cands)
	}
	for _, c := range cands {
		if c.Source == "wikipedia" && c.find == nil {
			t.Fatal("Wikipedia lookups must be lazy (no requests while a better candidate works)")
		}
	}
}
