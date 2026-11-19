// Package catalog keeps an always-fresh, self-hosted copy of every port,
// recomp and emulator listed in the shared catalog (src/lib/data/*.ts, exported
// to catalog.json by `npm run export:catalog`).
//
// It is deliberately dependency-free (stdlib only) so it can be tested in
// isolation and mounted into Fiber with a few lines (see main.go).
//
// What it does, without wasting resources:
//   - one request per *source* (repo/tag), never per item or platform
//   - conditional requests (ETag / If-None-Match) so unchanged releases cost a 304
//   - adaptive intervals: unchanged sources are checked less and less often,
//     failing sources back off exponentially
//   - mirrors a binary only when its upstream URL changes, stores it
//     content-addressed by SHA-256 (identical files are stored once)
//   - scrapes logos/covers once and revalidates them monthly
//   - persists everything to disk, so restarts never re-scrape
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

//go:embed catalog.json
var embeddedCatalog []byte

// Platforms supported by the catalog.
var Platforms = []string{"windows", "linux", "macos", "android", "ios"}

type ReleaseSource struct {
	Provider      string            `json:"provider"` // github | gitea
	Repo          string            `json:"repo"`
	Host          string            `json:"host,omitempty"`
	Tag           string            `json:"tag,omitempty"`
	Assets        map[string]string `json:"assets"`
	PlatformRepos map[string]string `json:"platformRepos,omitempty"`
}

// RepoFor returns the repository that publishes the given platform.
func (r *ReleaseSource) RepoFor(platform string) string {
	if r.PlatformRepos != nil {
		if repo := r.PlatformRepos[platform]; repo != "" {
			return repo
		}
	}
	return r.Repo
}

// ArtHints are artwork sources exported from src/lib/data/artSources.ts (curated) and
// artSources.generated.ts (resolved at build time by scripts/catalog/build-art.mjs).
type ArtHints struct {
	Cover    string `json:"cover,omitempty"`
	CoverFit string `json:"coverFit,omitempty"`
	// Covers lists every known cover, best first (Cover/CoverFit = the first one).
	Covers     []ArtRef `json:"covers,omitempty"`
	Logo       string   `json:"logo,omitempty"`
	GameLogo   string   `json:"gameLogo,omitempty"`
	SteamAppID int      `json:"steamAppId,omitempty"`
}

// ArtRef is one image; Fit "contain" = icon/logo/landscape image (shown whole), else box art.
type ArtRef struct {
	URL string `json:"url"`
	Fit string `json:"fit,omitempty"`
}

// CoverRefs returns the known covers, best first (falls back to the single Cover of older exports).
func (a *ArtHints) CoverRefs() []ArtRef {
	if a == nil {
		return nil
	}
	if len(a.Covers) > 0 {
		return a.Covers
	}
	if a.Cover != "" {
		return []ArtRef{{URL: a.Cover, Fit: a.CoverFit}}
	}
	return nil
}

type Images struct {
	Logo  string `json:"logo,omitempty"`
	Cover string `json:"cover,omitempty"`
}

// Item is the subset of a catalog entry the server needs. The full original
// JSON is kept in Raw and passed through untouched to API clients.
type Item struct {
	Kind         string            `json:"kind"` // port | emulator
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	ProjectName  string            `json:"projectName,omitempty"`
	Console      string            `json:"console,omitempty"`
	System       string            `json:"system,omitempty"`
	Author       string            `json:"author"`
	WebsiteURL   string            `json:"websiteUrl,omitempty"`
	GithubRepo   string            `json:"githubRepo,omitempty"`
	SupportedOS  []string          `json:"supportedOs"`
	DownloadURLs map[string]string `json:"downloadUrls"`
	Release      *ReleaseSource    `json:"release,omitempty"`
	DownloadPage string            `json:"downloadPage,omitempty"`
	Images       *Images           `json:"images,omitempty"`
	WikiTitle    string            `json:"wikiTitle,omitempty"`
	Art          *ArtHints         `json:"art,omitempty"`
	// ExternalIDs maps an external service to this item's id there
	// (e.g. "recomplauncher" → RecompLauncher app id, used to import player reviews).
	ExternalIDs map[string]string `json:"externalIds,omitempty"`
	// AlternativeOf is set on alternative ports of the same game (id of the primary port).
	AlternativeOf string `json:"alternativeOf,omitempty"`

	Raw json.RawMessage `json:"-"`
}

// Title used to look up artwork (game name for ports, emulator name otherwise).
func (it *Item) ArtTitle() string {
	if it.WikiTitle != "" {
		return it.WikiTitle
	}
	if it.Kind == "port" && it.ProjectName != "" {
		return it.ProjectName
	}
	return it.Name
}

var (
	parenRE = regexp.MustCompile(`\s*(\([^()]*\)|\[[^\[\]]*\])\s*`) // innermost (...) or [...]
	yearRE  = regexp.MustCompile(`\(((?:19|20)\d\d)\)`)
	splitRE = regexp.MustCompile(`\s+[/+]\s+`)
	spaceRE = regexp.MustCompile(`\s+`)
)

// cleanArtTitle turns catalog names into searchable titles:
// "Age of Wonders (aow-patch)" → "Age of Wonders", "Doom / Doom II / Heretic" → "Doom", "Diablo + Hellfire" → "Diablo".
func cleanArtTitle(t string) string {
	for i := 0; i < 4 && parenRE.MatchString(t); i++ { // nested: "AM2R (AM2R (Android))"
		t = parenRE.ReplaceAllString(t, " ")
	}
	t = splitRE.Split(t, 2)[0]
	t = strings.NewReplacer("™", "", "®", "", "©", "", "(", " ", ")", " ").Replace(t)
	return strings.TrimSpace(spaceRE.ReplaceAllString(t, " "))
}

// ArtSearchTitles are the Wikipedia titles worth trying for the item's artwork, best first.
// An explicit WikiTitle is used alone; games also try the "(video game)" disambiguated article.
func (it *Item) ArtSearchTitles() []string {
	if it.WikiTitle != "" {
		return []string{it.WikiTitle}
	}
	raw := it.ArtTitle()
	base := cleanArtTitle(raw)
	if base == "" {
		return nil
	}
	if it.Kind != "port" {
		return []string{base}
	}
	var out []string
	if m := yearRE.FindStringSubmatch(raw); m != nil {
		out = append(out, base+" ("+m[1]+" video game)")
	}
	return append(out, base+" (video game)", base)
}

// GitHubOwner returns the owner of the item's main GitHub repository, if any.
func (it *Item) GitHubOwner() string {
	repo := it.GithubRepo
	if repo == "" && it.Release != nil && it.Release.Provider == "github" {
		repo = it.Release.Repo
	}
	for i := 0; i < len(repo); i++ {
		if repo[i] == '/' {
			return repo[:i]
		}
	}
	return ""
}

type Catalog struct {
	SchemaVersion int
	Items         []*Item
	EmulatorPicks json.RawMessage
	SystemOrder   json.RawMessage
	byID          map[string]*Item
}

func (c *Catalog) Get(id string) *Item { return c.byID[id] }

// IsPort reports whether id is a port of the catalog (primary or alternative).
func (c *Catalog) IsPort(id string) bool {
	it := c.byID[id]
	return it != nil && it.Kind == "port"
}

// PortIDs returns the ids of every port (primary and alternative), in catalog order.
func (c *Catalog) PortIDs() []string {
	var out []string
	for _, it := range c.Items {
		if it.Kind == "port" {
			out = append(out, it.ID)
		}
	}
	return out
}

// PortsByExternalID maps an external id of `service` (see Item.ExternalIDs)
// to the ids of every port referencing it. Several ports may share one id.
func (c *Catalog) PortsByExternalID(service string) map[string][]string {
	out := map[string][]string{}
	for _, it := range c.Items {
		if it.Kind != "port" {
			continue
		}
		if ext := it.ExternalIDs[service]; ext != "" {
			out[ext] = append(out[ext], it.ID)
		}
	}
	return out
}

type catalogFile struct {
	SchemaVersion int               `json:"schemaVersion"`
	Ports         []json.RawMessage `json:"ports"`
	Emulators     []json.RawMessage `json:"emulators"`
	EmulatorPicks json.RawMessage   `json:"emulatorPicks"`
	SystemOrder   json.RawMessage   `json:"systemOrder"`
}

// Parse reads the JSON produced by scripts/export-catalog.ts.
func Parse(b []byte) (*Catalog, error) {
	var f catalogFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("catalog.json inválido: %w", err)
	}
	c := &Catalog{SchemaVersion: f.SchemaVersion, EmulatorPicks: f.EmulatorPicks, SystemOrder: f.SystemOrder, byID: map[string]*Item{}}
	for _, group := range [][]json.RawMessage{f.Ports, f.Emulators} {
		for _, raw := range group {
			it := &Item{}
			if err := json.Unmarshal(raw, it); err != nil {
				return nil, fmt.Errorf("item inválido no catálogo: %w", err)
			}
			if it.ID == "" {
				return nil, fmt.Errorf("item sem id no catálogo")
			}
			if _, dup := c.byID[it.ID]; dup {
				return nil, fmt.Errorf("id duplicado no catálogo: %s", it.ID)
			}
			it.Raw = append(json.RawMessage(nil), raw...)
			c.Items = append(c.Items, it)
			c.byID[it.ID] = it
		}
	}
	return c, nil
}

// Load returns the catalog from `path` when given, else the embedded copy.
func Load(path string) (*Catalog, error) {
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return Parse(b)
	}
	return Parse(embeddedCatalog)
}

// sourceKey identifies one upstream release feed. Several items/platforms can share it.
func sourceKey(provider, host, repo, tag string) string {
	return provider + "|" + host + "|" + repo + "|" + tag
}

// Sources returns the unique release feeds referenced by the catalog.
func (c *Catalog) Sources() []SourceRef {
	seen := map[string]SourceRef{}
	for _, it := range c.Items {
		if it.Release == nil {
			continue
		}
		for platform := range it.Release.Assets {
			repo := it.Release.RepoFor(platform)
			k := sourceKey(it.Release.Provider, it.Release.Host, repo, it.Release.Tag)
			seen[k] = SourceRef{Key: k, Provider: it.Release.Provider, Host: it.Release.Host, Repo: repo, Tag: it.Release.Tag}
		}
	}
	out := make([]SourceRef, 0, len(seen))
	for _, s := range seen {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

type SourceRef struct {
	Key      string
	Provider string
	Host     string
	Repo     string
	Tag      string
}
