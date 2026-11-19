package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AdminHandler serves the superadmin view of the scraping bots. Mount it BEHIND the admin auth
// (main.go: adminGroup → /api/admin/scrape*); it does no authentication of its own.
//
//	GET  /api/admin/scrape/status                 bots: live scraper (run, progress, history, coverage) + build-time report
//	GET  /api/admin/scrape/items?type=port|emulator|all&filter=missing|fallback|errors|pending|ok|all&q=&page=&size=&image=cover|logo
//	GET  /api/admin/scrape/items/{id}             one item: every image, attempts, candidate plan, build-time report
//	POST /api/admin/scrape/items/{id}/rescrape?kind=cover|logo   re-discover now (background) → 202
//	POST /api/admin/scrape/run?force=1&retry=1    start a run now (background) → 202, 409 when running
//	GET  /api/admin/scrape/build/report           full build-time report (scripts/catalog)
//	POST /api/admin/scrape/build/run?job=discover|ports|art|media&offline=1&budget=600   (only with CATALOG_BUILD_ROOT + node)
func (s *Service) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/admin/scrape/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.AdminStatus())
	})
	mux.HandleFunc("GET /api/admin/scrape/items", s.handleAdminItems)
	mux.HandleFunc("GET /api/admin/scrape/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		d, ok := s.AdminItem(r.PathValue("id"))
		if !ok {
			writeMsg(w, http.StatusNotFound, "item não encontrado no catálogo")
			return
		}
		writeJSON(w, http.StatusOK, d)
	})
	mux.HandleFunc("POST /api/admin/scrape/items/{id}/rescrape", func(w http.ResponseWriter, r *http.Request) {
		kinds, err := s.RescrapeItem(r.PathValue("id"), r.URL.Query().Get("kind"))
		switch {
		case errors.Is(err, ErrNotFound):
			writeMsg(w, http.StatusNotFound, "item não encontrado no catálogo")
		case errors.Is(err, ErrBusy):
			writeMsg(w, http.StatusConflict, "este item já está sendo raspado")
		case err != nil:
			writeMsg(w, http.StatusBadRequest, err.Error())
		default:
			writeJSON(w, http.StatusAccepted, map[string]any{"queued": true, "kinds": kinds})
		}
	})
	mux.HandleFunc("POST /api/admin/scrape/run", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if !s.StartRefresh(q.Get("force") == "1", q.Get("retry") == "1") {
			writeMsg(w, http.StatusConflict, "o robô já está rodando")
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
	})
	mux.HandleFunc("GET /api/admin/scrape/build/report", func(w http.ResponseWriter, r *http.Request) {
		raw, src := s.build.report()
		if raw == nil {
			writeMsg(w, http.StatusNotFound, "nenhum relatório de build")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Report-Source", src)
		w.Write(raw)
	})
	mux.HandleFunc("POST /api/admin/scrape/build/run", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		budget, _ := strconv.Atoi(q.Get("budget"))
		err := s.build.start(q.Get("job"), q.Get("offline") == "1", budget)
		switch {
		case errors.Is(err, ErrBuildDisabled):
			writeMsg(w, http.StatusNotImplemented, s.build.view(false).Reason)
		case errors.Is(err, ErrBusy):
			writeMsg(w, http.StatusConflict, "já há um robô de build rodando")
		case err != nil:
			writeMsg(w, http.StatusBadRequest, err.Error())
		default:
			writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
		}
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeMsg(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"message": msg})
}

// ---------------------------------------------------------------------------
// Image status
// ---------------------------------------------------------------------------

// Image status for the admin: ok | fallback (only a poor image: icon, landscape art, GitHub avatar/card,
// website icon) | missing (sources tried, nothing stored) | pending (never tried yet).
const (
	StatusOK       = "ok"
	StatusFallback = "fallback"
	StatusMissing  = "missing"
	StatusPending  = "pending"
)

type AdminImage struct {
	Kind        string         `json:"kind"`
	Status      string         `json:"status"`
	HasErrors   bool           `json:"hasErrors"`
	Busy        bool           `json:"busy,omitempty"`
	Source      string         `json:"source,omitempty"`
	SourceURL   string         `json:"sourceUrl,omitempty"`
	URL         string         `json:"url,omitempty"` // served copy (/api/catalog/images/{sha})
	FetchedAt   *time.Time     `json:"fetchedAt,omitempty"`
	CheckedAt   *time.Time     `json:"checkedAt,omitempty"`
	NextCheckAt *time.Time     `json:"nextCheckAt,omitempty"`
	Failures    int            `json:"failures,omitempty"`
	LastError   string         `json:"lastError,omitempty"`
	Attempts    []ImageAttempt `json:"attempts,omitempty"`
}

// isFallbackImage: the stored image is not real box art / logo but a stand-in.
func isFallbackImage(it *Item, kind string, st *ImageState) bool {
	switch st.Source {
	case "github", "website":
		return true
	}
	u := strings.ToLower(st.SourceURL)
	if kind == "cover" {
		if strings.HasSuffix(u, ".svg") || strings.Contains(u, "opengraph.githubassets.com") {
			return true // a logo or GitHub's auto-generated repository card
		}
		if it.Art != nil {
			for _, c := range it.Art.CoverRefs() {
				if c.Fit == "contain" && (c.URL == st.SourceURL || libretroMirror(c.URL) == st.SourceURL) {
					return true // icon / landscape screenshot shown whole
				}
			}
		}
	}
	return false
}

func (s *Service) imageViewLocked(it *Item, kind string, withAttempts bool) AdminImage {
	v := AdminImage{Kind: kind, Status: StatusPending}
	_, v.Busy = s.jobs[imageKey(it.ID, kind)]
	st := s.state.Images[imageKey(it.ID, kind)]
	if st == nil {
		return v
	}
	v.Source, v.SourceURL, v.Failures, v.LastError = st.Source, st.SourceURL, st.Failures, st.LastError
	v.FetchedAt, v.CheckedAt, v.NextCheckAt = tp(st.FetchedAt), tp(st.CheckedAt), tp(st.NextCheckAt)
	v.HasErrors = st.Failures > 0
	for _, a := range st.Attempts {
		if a.IsFailure() {
			v.HasErrors = true
			break
		}
	}
	if withAttempts {
		v.Attempts = st.Attempts
	}
	switch {
	case st.SHA256 != "" && s.blobs.has(st.SHA256):
		v.URL = s.abs("/api/catalog/images/" + st.SHA256)
		v.Status = StatusOK
		if isFallbackImage(it, kind, st) {
			v.Status = StatusFallback
		}
	case st.Failures > 0 || !st.CheckedAt.IsZero() || st.LastError != "":
		v.Status = StatusMissing
	}
	return v
}

func primaryKind(it *Item) string {
	if it.Kind == "port" {
		return "cover"
	}
	return "logo"
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type Coverage struct {
	Total    int `json:"total"`
	OK       int `json:"ok"`
	Fallback int `json:"fallback"`
	Missing  int `json:"missing"`
	Pending  int `json:"pending"`
	Errors   int `json:"errors"`
}

func (c *Coverage) add(v AdminImage) {
	c.Total++
	switch v.Status {
	case StatusOK:
		c.OK++
	case StatusFallback:
		c.Fallback++
	case StatusMissing:
		c.Missing++
	default:
		c.Pending++
	}
	if v.HasErrors {
		c.Errors++
	}
}

type SourceProblem struct {
	Key         string     `json:"key"`
	Error       string     `json:"error"`
	Failures    int        `json:"failures"`
	CheckedAt   *time.Time `json:"checkedAt,omitempty"`
	NextCheckAt *time.Time `json:"nextCheckAt,omitempty"`
}

type AdminJob struct {
	ItemID    string    `json:"itemId"`
	Kind      string    `json:"kind"`
	StartedAt time.Time `json:"startedAt"`
}

type ScraperStatus struct {
	Loop      bool         `json:"loop"` // the background timer runs on this server (CATALOG_SCRAPER != false)
	Running   bool         `json:"running"`
	Progress  *RunProgress `json:"progress,omitempty"`
	LastRun   *RunStats    `json:"lastRun,omitempty"`
	Runs      []RunStats   `json:"runs"` // newest first
	NextRunAt *time.Time   `json:"nextRunAt,omitempty"`
	TickSec   int64        `json:"tickSec"`
	Sources   struct {
		Total    int             `json:"total"`
		Failing  int             `json:"failing"`
		Problems []SourceProblem `json:"problems"`
	} `json:"sources"`
	Mirrors struct {
		Total   int `json:"total"`
		Stored  int `json:"stored"`
		Failing int `json:"failing"`
	} `json:"mirrors"`
	// Coverage per item type and image kind: "port:cover", "port:logo", "emulator:logo".
	Coverage map[string]*Coverage `json:"coverage"`
	Jobs     []AdminJob           `json:"jobs"`
	Config   struct {
		SteamGridDB      bool  `json:"steamGridDB"`
		GitHubToken      bool  `json:"githubToken"`
		Mirror           bool  `json:"mirror"`
		ImageIntervalSec int64 `json:"imageIntervalSec"`
	} `json:"config"`
}

type BuildStatus struct {
	Report       map[string]any  `json:"report"`
	ReportSource string          `json:"reportSource,omitempty"` // runtime | embedded
	ReportPath   string          `json:"reportPath,omitempty"`
	Runner       buildRunnerView `json:"runner"`
	Jobs         []buildJobView  `json:"jobs"`
}

type AdminStatusResponse struct {
	Enabled bool          `json:"enabled"`
	Now     time.Time     `json:"now"`
	Scraper ScraperStatus `json:"scraper"`
	Build   BuildStatus   `json:"build"`
}

func (s *Service) AdminStatus() AdminStatusResponse {
	out := AdminStatusResponse{Enabled: true, Now: time.Now()}
	sc := &out.Scraper
	sc.Loop, sc.Running = s.loop.Load(), s.running.Load()
	sc.TickSec = int64(s.cfg.Tick / time.Second)
	sc.Config.SteamGridDB = s.cfg.SteamGridDBKey != ""
	sc.Config.GitHubToken = s.cfg.GitHubToken != ""
	sc.Config.Mirror = s.cfg.Mirror
	sc.Config.ImageIntervalSec = int64(s.cfg.ImageInterval / time.Second)

	s.mu.Lock()
	if sc.Running && s.progress.Phase != "" {
		p := s.progress
		sc.Progress = &p
	}
	if !s.lastRun.StartedAt.IsZero() {
		lr := s.lastRun
		sc.LastRun = &lr
	}
	sc.Runs = make([]RunStats, 0, len(s.state.Runs))
	for i := len(s.state.Runs) - 1; i >= 0; i-- {
		sc.Runs = append(sc.Runs, s.state.Runs[i])
	}
	if sc.Loop {
		sc.NextRunAt = tp(s.nextRunAt)
	}
	sc.Sources.Total = len(s.cat.Sources())
	sc.Sources.Problems = []SourceProblem{}
	for k, src := range s.state.Sources {
		if src.LastError == "" {
			continue
		}
		sc.Sources.Failing++
		sc.Sources.Problems = append(sc.Sources.Problems, SourceProblem{Key: k, Error: src.LastError, Failures: src.Failures,
			CheckedAt: tp(src.CheckedAt), NextCheckAt: tp(src.NextCheckAt)})
	}
	for _, m := range s.state.Mirrors {
		sc.Mirrors.Total++
		if m.SHA256 != "" {
			sc.Mirrors.Stored++
		}
		if m.LastError != "" {
			sc.Mirrors.Failing++
		}
	}
	sc.Coverage = map[string]*Coverage{}
	for _, it := range s.cat.Items {
		for _, kind := range imageKinds(it) {
			k := it.Kind + ":" + kind
			if sc.Coverage[k] == nil {
				sc.Coverage[k] = &Coverage{}
			}
			sc.Coverage[k].add(s.imageViewLocked(it, kind, false))
		}
	}
	sc.Jobs = []AdminJob{}
	for key, at := range s.jobs {
		i := strings.LastIndex(key, "|")
		sc.Jobs = append(sc.Jobs, AdminJob{ItemID: key[:i], Kind: key[i+1:], StartedAt: at})
	}
	s.mu.Unlock()

	sort.Slice(sc.Sources.Problems, func(i, j int) bool {
		a, b := sc.Sources.Problems[i], sc.Sources.Problems[j]
		if a.Failures != b.Failures {
			return a.Failures > b.Failures
		}
		return a.Key < b.Key
	})
	if len(sc.Sources.Problems) > 50 {
		sc.Sources.Problems = sc.Sources.Problems[:50]
	}
	sort.Slice(sc.Jobs, func(i, j int) bool { return sc.Jobs[i].StartedAt.Before(sc.Jobs[j].StartedAt) })

	raw, src := s.build.report()
	out.Build = BuildStatus{Report: summarizeReport(raw), ReportSource: src, ReportPath: s.build.reportPath,
		Runner: s.build.view(false), Jobs: jobViews()}
	return out
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

type AdminItemRow struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	ProjectName   string       `json:"projectName,omitempty"`
	Type          string       `json:"type"` // port | emulator
	Console       string       `json:"console,omitempty"`
	AlternativeOf string       `json:"alternativeOf,omitempty"`
	Primary       string       `json:"primary"` // image kind the filters look at
	Images        []AdminImage `json:"images"`
}

type AdminItemsResponse struct {
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	Size     int            `json:"size"`
	Counts   map[string]int `json:"counts"` // all, missing, fallback, errors, pending, ok (type + q, ignoring filter)
	Items    []AdminItemRow `json:"items"`
	Filter   string         `json:"filter"`
	Type     string         `json:"type"`
	Running  bool           `json:"running"`
	JobCount int            `json:"jobCount"`
}

func severity(v AdminImage) int {
	switch v.Status {
	case StatusMissing:
		return 0
	case StatusPending:
		return 1
	case StatusFallback:
		if v.HasErrors {
			return 2
		}
		return 3
	}
	if v.HasErrors {
		return 4
	}
	return 5
}

func matchesFilter(v AdminImage, filter string) bool {
	switch filter {
	case "missing":
		return v.Status == StatusMissing || v.Status == StatusPending
	case "fallback":
		return v.Status == StatusFallback
	case "errors":
		return v.HasErrors
	case "pending":
		return v.Status == StatusPending
	case "ok":
		return v.Status == StatusOK
	}
	return true
}

func (s *Service) handleAdminItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	writeJSON(w, http.StatusOK, s.AdminItems(q.Get("type"), q.Get("filter"), q.Get("q"), q.Get("image"), page, size))
}

// AdminItems lists catalog items with their image status, worst first.
func (s *Service) AdminItems(typ, filter, query, image string, page, size int) AdminItemsResponse {
	if typ == "" {
		typ = "port"
	}
	if filter == "" {
		filter = "all"
	}
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = 50
	}
	size = min(size, 200)
	query = strings.ToLower(strings.TrimSpace(query))

	type row struct {
		r   AdminItemRow
		key AdminImage
	}
	var rows []row
	counts := map[string]int{"all": 0, "missing": 0, "fallback": 0, "errors": 0, "pending": 0, "ok": 0}
	s.mu.Lock()
	for _, it := range s.cat.Items {
		if typ != "all" && it.Kind != typ {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(it.Name+"\x00"+it.ProjectName+"\x00"+it.ID+"\x00"+it.Console+"\x00"+it.System), query) {
			continue
		}
		kinds := imageKinds(it)
		pk := primaryKind(it)
		if image != "" {
			found := false
			for _, k := range kinds {
				found = found || k == image
			}
			if !found {
				continue
			}
			pk = image
		}
		ar := AdminItemRow{ID: it.ID, Name: it.Name, ProjectName: it.ProjectName, Type: it.Kind, Console: it.Console,
			AlternativeOf: it.AlternativeOf, Primary: pk}
		if ar.Console == "" {
			ar.Console = it.System
		}
		var key AdminImage
		for _, k := range kinds {
			v := s.imageViewLocked(it, k, true)
			if k == pk {
				key = v
			}
			ar.Images = append(ar.Images, v)
		}
		counts["all"]++
		for _, f := range []string{"missing", "fallback", "errors", "pending", "ok"} {
			if matchesFilter(key, f) {
				counts[f]++
			}
		}
		if matchesFilter(key, filter) {
			rows = append(rows, row{ar, key})
		}
	}
	running, jobs := s.running.Load(), len(s.jobs)
	s.mu.Unlock()

	sort.SliceStable(rows, func(i, j int) bool {
		a, b := severity(rows[i].key), severity(rows[j].key)
		if a != b {
			return a < b
		}
		return strings.ToLower(rows[i].r.Name) < strings.ToLower(rows[j].r.Name)
	})
	out := AdminItemsResponse{Total: len(rows), Page: page, Size: size, Counts: counts, Items: []AdminItemRow{},
		Filter: filter, Type: typ, Running: running, JobCount: jobs}
	for i := (page - 1) * size; i < len(rows) && i < page*size; i++ {
		out.Items = append(out.Items, rows[i].r)
	}
	return out
}

type PlanStep struct {
	Source string `json:"source"`
	URL    string `json:"url,omitempty"`
	Lookup string `json:"lookup,omitempty"` // lazy lookup (costs requests), e.g. "artigo: Doom (video game)"
}

type AdminItemDetail struct {
	AdminItemRow
	Plan      map[string][]PlanStep `json:"plan"` // sources the bot tries, best first, per image kind
	BuildArt  *BuildArtEntry        `json:"buildArt,omitempty"`
	Art       *ArtHints             `json:"art,omitempty"`
	WikiTitle string                `json:"wikiTitle,omitempty"`
	Running   bool                  `json:"running"`
}

// AdminItem returns one item with its full attempt logs and the candidate plan (no requests made).
func (s *Service) AdminItem(id string) (AdminItemDetail, bool) {
	it := s.cat.Get(id)
	if it == nil {
		return AdminItemDetail{}, false
	}
	d := AdminItemDetail{Plan: map[string][]PlanStep{}, Art: it.Art, WikiTitle: it.WikiTitle, Running: s.running.Load()}
	d.ID, d.Name, d.ProjectName, d.Type, d.Console, d.AlternativeOf, d.Primary = it.ID, it.Name, it.ProjectName, it.Kind, it.Console, it.AlternativeOf, primaryKind(it)
	if d.Console == "" {
		d.Console = it.System
	}
	s.mu.Lock()
	for _, k := range imageKinds(it) {
		d.Images = append(d.Images, s.imageViewLocked(it, k, true))
	}
	s.mu.Unlock()
	for _, k := range imageKinds(it) {
		steps := []PlanStep{}
		// discoverImage only builds closures for lookups: no request is made here.
		for _, c := range s.discoverImage(context.Background(), it, k) {
			steps = append(steps, PlanStep{Source: c.Source, URL: c.URL, Lookup: c.Detail})
		}
		d.Plan[k] = steps
	}
	raw, _ := s.build.report()
	d.BuildArt = buildArtFor(raw, it.ProjectName, it.Name)
	return d, true
}
