package handlers

import (
	"bufio"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

// Open data API (/api/public): ports and players' reviews that anyone may read, export and reuse,
// from any site (CORS "*", see cors.go). Documented in docs/API_PUBLICA.md and on the site (/dados).
// Writing reviews stays at POST /api/reviews (login, rate limit, one review per user, port and platform).

const (
	publicAPIVersion     = 1
	publicPortsMax       = 500
	publicReviewsDefault = 1000
	publicReviewsMax     = 5000
	publicSummaryTTL     = 5 * time.Minute
	// PublicDataLicense applies to the MemoryCard's own reviews. Imported items keep their source's terms
	// and must keep the credit (fields source/sourceName/sourceUrl).
	PublicDataLicense    = "CC BY 4.0"
	PublicDataLicenseURL = "https://creativecommons.org/licenses/by/4.0/deed.pt-br"
)

// ReviewSourceInfo describes where a review (or external rating) comes from, for the credit line.
type ReviewSourceInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Kind    string `json:"kind"` // reports (players' reports) | curation (curators' grades) | badge
	License string `json:"license"`
}

// PublicSources lists every source of reviews/ratings shown by MemoryCard.
var PublicSources = []ReviewSourceInfo{
	{ID: models.ReviewSourceMemoryCard, Name: "MemoryCard", URL: "https://memorycard.cloud", Kind: "reports", License: PublicDataLicense},
	{ID: models.ReviewSourceRecompLauncher, Name: "RecompLauncher", URL: "https://recomplauncher.com", Kind: "reports", License: "relatos públicos e anônimos do RecompLauncher; mantenha o crédito"},
	{ID: "awesome-decomp-games", Name: "awesome-decomp-games", URL: "https://github.com/SubmitGame/awesome-decomp-games", Kind: "curation", License: "notas de curadoria da lista; mantenha o crédito"},
	{ID: "ports-launcher", Name: "Ports Launcher", URL: "https://github.com/Nyaldee/Ports-Launcher", Kind: "badge", License: "selo \"quality\" do catálogo; mantenha o crédito"},
}

func sourceInfo(id string) ReviewSourceInfo {
	for _, s := range PublicSources {
		if s.ID == id {
			return s
		}
	}
	return ReviewSourceInfo{ID: id, Name: id}
}

// ---- summaries cache (map), shared by the public endpoints ---------------------------------------

var publicSummaries struct {
	sync.Mutex
	at  time.Time
	all map[string]*ReviewSummary
}

func publicSummaryMap() (map[string]*ReviewSummary, error) {
	publicSummaries.Lock()
	defer publicSummaries.Unlock()
	if publicSummaries.all != nil && time.Since(publicSummaries.at) < publicSummaryTTL {
		return publicSummaries.all, nil
	}
	m, err := queryReviewSummaries(database.DB, "")
	if err != nil {
		return nil, err
	}
	publicSummaries.all, publicSummaries.at = m, time.Now()
	return m, nil
}

func invalidatePublicSummaries() {
	publicSummaries.Lock()
	publicSummaries.all = nil
	publicSummaries.Unlock()
}

// ---- ports ---------------------------------------------------------------------------------------

// PublicPort is the open-data view of a catalog port.
type PublicPort struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Game          string            `json:"game"`
	Console       string            `json:"console,omitempty"`
	PortType      string            `json:"portType,omitempty"`
	Author        string            `json:"author"`
	Repo          string            `json:"repo,omitempty"`
	WebsiteURL    string            `json:"websiteUrl,omitempty"`
	SupportedOS   []string          `json:"supportedOs"`
	AlternativeOf string            `json:"alternativeOf,omitempty"`
	Stats         json.RawMessage   `json:"stats,omitempty"`
	ExternalIDs   map[string]string `json:"externalIds,omitempty"`
	Reviews       *ReviewSummary    `json:"reviews"`
	Links         map[string]string `json:"links"`
}

type portExtra struct {
	PortType string          `json:"portType"`
	Stats    json.RawMessage `json:"stats"`
}

func publicPortFrom(id string, sums map[string]*ReviewSummary) *PublicPort {
	cat, err := reviewCatalog()
	if err != nil {
		return nil
	}
	it := cat.Get(id)
	if it == nil || it.Kind != "port" {
		return nil
	}
	var extra portExtra
	_ = json.Unmarshal(it.Raw, &extra)
	repo := it.GithubRepo
	if it.Release != nil && it.Release.Repo != "" {
		repo = it.Release.Repo
	}
	p := &PublicPort{
		ID: it.ID, Name: it.Name, Game: it.ProjectName, Console: it.Console, PortType: extra.PortType,
		Author: it.Author, Repo: repo, WebsiteURL: it.WebsiteURL, SupportedOS: it.SupportedOS,
		AlternativeOf: it.AlternativeOf, Stats: extra.Stats, ExternalIDs: it.ExternalIDs,
		Reviews: sums[it.ID],
		Links: map[string]string{
			"page":    "https://memorycard.cloud/ports/" + it.ID,
			"reviews": "/api/public/reviews?port=" + it.ID,
		},
	}
	if p.SupportedOS == nil {
		p.SupportedOS = []string{}
	}
	return p
}

// PublicIndex: GET /api/public — what is available, license and credits.
func PublicIndex(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "public, max-age=3600")
	return c.JSON(fiber.Map{
		"name":      "MemoryCard Open Data",
		"version":   publicAPIVersion,
		"docs":      "https://memorycard.cloud/dados",
		"license":   fiber.Map{"memorycard": PublicDataLicense, "url": PublicDataLicenseURL, "thirdParty": "itens importados mantêm os termos e o crédito da fonte (source, sourceName, sourceUrl)"},
		"sources":   PublicSources,
		"rateLimit": "leitura livre (cache de 5 min); escrita: POST /api/reviews com login, 20 por hora por conta e 40 por hora por IP",
		"endpoints": fiber.Map{
			"ports":        "GET /api/public/ports?primary=1&console=&q=&limit=&offset=",
			"port":         "GET /api/public/ports/{id}",
			"reviews":      "GET /api/public/reviews?port=&source=&since=&after=&limit=&format=json|ndjson",
			"summary":      "GET /api/reviews/summary[?source=memorycard|recomplauncher]",
			"catalog":      "GET /api/catalog (catálogo completo do app, com versões e espelhos)",
			"createReview": "POST /api/reviews (Authorization: Bearer <token>)",
		},
	})
}

// PublicSourcesList: GET /api/public/sources.
func PublicSourcesList(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "public, max-age=3600")
	return c.JSON(fiber.Map{"sources": PublicSources})
}

// PublicPorts: GET /api/public/ports?primary=1&console=Nintendo%20Switch&q=zelda&limit=100&offset=0
func PublicPorts(c *fiber.Ctx) error {
	cat, err := reviewCatalog()
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": "Catálogo indisponível"})
	}
	sums, err := publicSummaryMap()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
	}
	primaryOnly := c.Query("primary") == "1" || c.Query("primary") == "true"
	consoleQ := strings.ToLower(strings.TrimSpace(c.Query("console")))
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))
	limit := c.QueryInt("limit", 100)
	if limit < 1 || limit > publicPortsMax {
		limit = publicPortsMax
	}
	offset := c.QueryInt("offset", 0)
	if offset < 0 {
		offset = 0
	}
	items := []*PublicPort{}
	total := 0
	for _, id := range cat.PortIDs() {
		it := cat.Get(id)
		if primaryOnly && it.AlternativeOf != "" {
			continue
		}
		if consoleQ != "" && strings.ToLower(it.Console) != consoleQ {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(it.Name+" "+it.ProjectName+" "+it.GithubRepo), q) {
			continue
		}
		total++
		if total <= offset || len(items) >= limit {
			continue
		}
		if p := publicPortFrom(id, sums); p != nil {
			items = append(items, p)
		}
	}
	c.Set("X-Total-Count", strconv.Itoa(total))
	c.Set(fiber.HeaderCacheControl, "public, max-age=300")
	return c.JSON(fiber.Map{"total": total, "offset": offset, "limit": limit, "items": items})
}

// PublicPortDetail: GET /api/public/ports/:id — the port, its summary and the other projects of the same game.
func PublicPortDetail(c *fiber.Ctx) error {
	cat, err := reviewCatalog()
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": "Catálogo indisponível"})
	}
	sums, err := publicSummaryMap()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
	}
	p := publicPortFrom(c.Params("id"), sums)
	if p == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Port não encontrado no catálogo"})
	}
	main := p.ID
	if p.AlternativeOf != "" {
		main = p.AlternativeOf
	}
	options := []*PublicPort{}
	for _, id := range cat.PortIDs() {
		it := cat.Get(id)
		if id == main || it.AlternativeOf == main {
			if o := publicPortFrom(id, sums); o != nil {
				options = append(options, o)
			}
		}
	}
	// soma do jogo: todas as versões juntas
	game := newReviewSummary()
	for _, o := range options {
		if o.Reviews != nil {
			mergeSummary(game, o.Reviews)
		}
	}
	game.finishMerged()
	c.Set(fiber.HeaderCacheControl, "public, max-age=300")
	return c.JSON(fiber.Map{"port": p, "options": options, "gameReviews": game})
}

// mergeSummary adds b into a (averages are recomputed by finishMerged).
func mergeSummary(a, b *ReviewSummary) {
	a.Total += b.Total
	a.Runs += b.Runs
	a.Issues += b.Issues
	a.Broken += b.Broken
	for k, v := range b.Sources {
		a.Sources[k] += v
	}
	for k, v := range b.Platforms {
		a.Platforms[k] += v
	}
	a.Devices += b.Devices
	a.StutterYes += b.StutterYes
	a.StutterNo += b.StutterNo
	a.ratingSum += b.ratingSum
	a.RatingCount += b.RatingCount
	a.fpsSum += b.fpsSum
	a.fpsCount += b.fpsCount
}

func (s *ReviewSummary) finishMerged() { s.finish() }

// ---- reviews export ------------------------------------------------------------------------------

// PublicReview is one review in the export, with the credit of its source.
type PublicReview struct {
	ID         uint      `json:"id"`
	Port       string    `json:"port"`
	Game       string    `json:"game,omitempty"`
	Source     string    `json:"source"`
	SourceName string    `json:"sourceName"`
	SourceURL  string    `json:"sourceUrl"`
	Author     string    `json:"author"`
	Hardware   string    `json:"hardware"`
	Platform   string    `json:"platform"`
	Version    string    `json:"version"`
	Rating     *int      `json:"rating"`
	Verdict    string    `json:"verdict"`
	FPS        *int      `json:"fps"`
	Stutter    *bool     `json:"stutter"`
	Note       string    `json:"note"`
	CreatedAt  time.Time `json:"createdAt"`
}

// PublicReviews: GET /api/public/reviews?port=&source=&since=2026-01-01&after=<id>&limit=1000&format=json|ndjson
// Ordered by id (stable): to export everything, follow `next` (or the Link header) until it is null.
func PublicReviews(c *fiber.Ctx) error {
	limit := c.QueryInt("limit", publicReviewsDefault)
	if limit < 1 || limit > publicReviewsMax {
		limit = publicReviewsMax
	}
	q := database.DB.Model(&models.PortReview{}).Where("hidden = ?", false)
	if port := strings.TrimSpace(c.Query("port")); port != "" {
		q = q.Where("port_id = ?", port)
	}
	if src := strings.TrimSpace(c.Query("source")); src != "" {
		q = q.Where("source = ?", src)
	}
	if since := strings.TrimSpace(c.Query("since")); since != "" {
		t, err := time.Parse(time.RFC3339, since)
		if err != nil {
			t, err = time.Parse("2006-01-02", since)
		}
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "since: use AAAA-MM-DD ou RFC 3339"})
		}
		q = q.Where("created_at >= ?", t)
	}
	if after := c.QueryInt("after", 0); after > 0 {
		q = q.Where("id > ?", after)
	}
	rows := []models.PortReview{}
	if err := q.Order("id ASC").Limit(limit).Find(&rows).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao exportar avaliações"})
	}
	cat, _ := reviewCatalog()
	out := make([]PublicReview, 0, len(rows))
	for _, r := range rows {
		si := sourceInfo(r.Source)
		game := ""
		if cat != nil {
			if it := cat.Get(r.PortID); it != nil {
				game = it.ProjectName
			}
		}
		out = append(out, PublicReview{
			ID: r.ID, Port: r.PortID, Game: game, Source: r.Source, SourceName: si.Name, SourceURL: si.URL,
			Author: r.Author, Hardware: r.Hardware, Platform: r.Platform, Version: r.Version, Rating: r.Rating,
			Verdict: r.Verdict, FPS: r.FPS, Stutter: r.Stutter, Note: r.Note, CreatedAt: r.CreatedAt,
		})
	}
	var next *string
	if len(rows) == limit {
		qs := c.Context().QueryArgs()
		args := []string{}
		qs.VisitAll(func(k, v []byte) {
			if string(k) != "after" {
				args = append(args, string(k)+"="+string(v))
			}
		})
		sort.Strings(args)
		args = append(args, "after="+strconv.FormatUint(uint64(rows[len(rows)-1].ID), 10))
		u := c.Path() + "?" + strings.Join(args, "&")
		next = &u
		c.Set("Link", "<"+u+">; rel=\"next\"")
	}
	c.Set(fiber.HeaderCacheControl, "public, max-age=300")
	if c.Query("format") == "ndjson" {
		c.Set(fiber.HeaderContentType, "application/x-ndjson; charset=utf-8")
		c.Set(fiber.HeaderContentDisposition, `inline; filename="memorycard-reviews.ndjson"`)
		w := bufio.NewWriter(c.Response().BodyWriter())
		enc := json.NewEncoder(w)
		for i := range out {
			if err := enc.Encode(&out[i]); err != nil {
				return err
			}
		}
		return w.Flush()
	}
	return c.JSON(fiber.Map{
		"license": fiber.Map{"memorycard": PublicDataLicense, "url": PublicDataLicenseURL, "thirdParty": "mantenha o crédito da fonte de cada item"},
		"count":   len(out),
		"next":    next,
		"items":   out,
	})
}
