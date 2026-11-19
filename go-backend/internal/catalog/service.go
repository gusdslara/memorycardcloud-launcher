package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Config struct {
	DataDir        string
	CatalogPath    string // optional override of the embedded catalog.json
	PublicBaseURL  string // e.g. https://memorycard.cloud (absolute URLs in responses)
	UserAgent      string
	Tick           time.Duration
	MinInterval    time.Duration
	MaxInterval    time.Duration
	RetryBase      time.Duration
	ImageInterval  time.Duration
	Mirror         bool
	MirrorPlatform map[string]bool
	MaxMirrorBytes int64
	// MirrorTotalBytes caps the whole mirror (0 = no limit); see mirrorSelectionLocked.
	MirrorTotalBytes int64
	MaxImageBytes    int64
	Concurrency      int
	GitHubToken      string
	SteamGridDBKey   string
	AdminToken       string
	// Build-time bots (scripts/catalog, Node): BuildRoot = repository root where the admin may run them
	// (empty = disabled, e.g. the production image has no node); BuildReportPath = runtime report.
	BuildRoot       string
	NodeBin         string
	BuildReportPath string

	// Overridable for tests.
	GitHubAPI          string
	GitHubWeb          string
	WikipediaAPI       string
	WikipediaActionAPI string
	SteamCDN           string
	SteamGridDBAPI     string
	GiteaBaseOverride  string
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	if v := os.Getenv(k); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

// ConfigFromEnv reads CATALOG_* variables (see .env.example).
func ConfigFromEnv() Config {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	maxMB, _ := strconv.ParseInt(os.Getenv("CATALOG_MIRROR_MAX_MB"), 10, 64)
	if maxMB <= 0 {
		maxMB = 1024
	}
	// Teto do espelho inteiro (o disco da VPS é compartilhado): 30 GB por padrão, 0 = sem teto.
	totalMB, err := strconv.ParseInt(os.Getenv("CATALOG_MIRROR_TOTAL_MB"), 10, 64)
	if err != nil || totalMB < 0 {
		totalMB = 30 << 10
	}
	platforms := map[string]bool{}
	for _, p := range strings.Split(envOr("CATALOG_MIRROR_PLATFORMS", strings.Join(Platforms, ",")), ",") {
		if p = strings.TrimSpace(p); p != "" {
			platforms[p] = true
		}
	}
	return Config{
		DataDir:            filepath.Join(dataDir, "catalog"),
		CatalogPath:        os.Getenv("CATALOG_PATH"),
		PublicBaseURL:      strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"),
		UserAgent:          envOr("CATALOG_USER_AGENT", "MemoryCardCloud-CatalogBot/1.0 (+https://memorycard.cloud)"),
		Tick:               envDur("CATALOG_TICK", 15*time.Minute),
		MinInterval:        envDur("CATALOG_MIN_INTERVAL", 6*time.Hour),
		MaxInterval:        envDur("CATALOG_MAX_INTERVAL", 48*time.Hour),
		RetryBase:          envDur("CATALOG_RETRY_BASE", time.Hour),
		ImageInterval:      envDur("CATALOG_IMAGE_INTERVAL", 30*24*time.Hour),
		Mirror:             envBool("CATALOG_MIRROR", true),
		MirrorPlatform:     platforms,
		MaxMirrorBytes:     maxMB << 20,
		MirrorTotalBytes:   totalMB << 20,
		MaxImageBytes:      8 << 20,
		Concurrency:        2,
		GitHubToken:        os.Getenv("GITHUB_TOKEN"),
		SteamGridDBKey:     os.Getenv("STEAMGRIDDB_API_KEY"),
		AdminToken:         os.Getenv("CATALOG_ADMIN_TOKEN"),
		BuildRoot:          os.Getenv("CATALOG_BUILD_ROOT"),
		NodeBin:            os.Getenv("CATALOG_NODE"),
		BuildReportPath:    envOr("CATALOG_BUILD_REPORT", filepath.Join(dataDir, "catalog", "build-report.json")),
		GitHubAPI:          "https://api.github.com",
		GitHubWeb:          "https://github.com",
		WikipediaAPI:       "https://en.wikipedia.org/api/rest_v1",
		WikipediaActionAPI: "https://en.wikipedia.org/w/api.php",
		SteamCDN:           "https://cdn.cloudflare.steamstatic.com",
		SteamGridDBAPI:     "https://www.steamgriddb.com/api/v2",
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type RunStats struct {
	StartedAt        time.Time `json:"startedAt"`
	FinishedAt       time.Time `json:"finishedAt"`
	SourcesChecked   int       `json:"sourcesChecked"`
	SourcesChanged   int       `json:"sourcesChanged"`
	NotModified      int       `json:"notModified"`
	Errors           int       `json:"errors"`
	Mirrored         int       `json:"mirrored"`
	MirrorBytes      int64     `json:"mirrorBytes"`
	ImagesChecked    int       `json:"imagesChecked"`
	FreedBytes       int64     `json:"freedBytes"`
	SkippedNotDueYet int       `json:"skippedNotDue"`
	// Image step: how many images were looked at, found (stored or revalidated) and not found.
	ImagesFound       int `json:"imagesFound"`
	ImagesFailed      int `json:"imagesFailed"`
	ImagesRevalidated int `json:"imagesRevalidated"`
	// Trigger = timer | force | admin; Error = what stopped the run (cancelled, state not saved...).
	Trigger string `json:"trigger,omitempty"`
	Forced  bool   `json:"forced,omitempty"`
	Error   string `json:"error,omitempty"`
}

// RunProgress tells what a running scrape is doing right now (admin polling).
type RunProgress struct {
	Phase   string `json:"phase"` // sources | mirror | images | gc
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Current string `json:"current,omitempty"`
}

type Service struct {
	cfg    Config
	cat    *Catalog
	client *http.Client
	blobs  blobStore

	mu      sync.Mutex
	state   *State
	lastRun RunStats

	running   atomic.Bool
	trigger   chan bool // true = force
	loop      atomic.Bool
	progress  RunProgress          // guarded by mu
	nextRunAt time.Time            // guarded by mu
	jobs      map[string]time.Time // admin re-scrapes in progress (itemID|kind), guarded by mu
	gcMu      sync.RWMutex         // item jobs (RLock) vs. blob garbage collection (Lock)
	build     buildRunner

	syncJobs bool // tests: RescrapeItem waits for the job

	respMu   sync.RWMutex
	response []byte
	respETag string
	itemResp map[string][]byte
}

func New(cfg Config) (*Service, error) {
	cat, err := Load(cfg.CatalogPath)
	if err != nil {
		return nil, err
	}
	st, err := loadState(filepath.Join(cfg.DataDir, "state.json"))
	if err != nil {
		return nil, err
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 2
	}
	s := &Service{
		cfg:     cfg,
		cat:     cat,
		client:  &http.Client{Timeout: 0, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConnsPerHost: 4}},
		blobs:   blobStore{dir: filepath.Join(cfg.DataDir, "blobs")},
		state:   st,
		trigger: make(chan bool, 1),
		jobs:    map[string]time.Time{},
	}
	if n := len(st.Runs); n > 0 {
		s.lastRun = st.Runs[n-1]
	}
	s.build.init(cfg)
	s.rebuildResponse()
	return s, nil
}

func (s *Service) Catalog() *Catalog { return s.cat }

// Run refreshes on a timer until ctx ends. Safe to call once in a goroutine.
func (s *Service) Run(ctx context.Context) {
	s.loop.Store(true)
	defer s.loop.Store(false)
	timer := time.NewTimer(10 * time.Second) // let the server boot first
	defer timer.Stop()
	s.setNextRun(time.Now().Add(10 * time.Second))
	for {
		force := false
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case force = <-s.trigger:
		}
		if _, err := s.Refresh(ctx, force); err != nil && ctx.Err() == nil {
			log.Printf("[catalog] refresh: %v", err)
		}
		timer.Reset(s.cfg.Tick)
		s.setNextRun(time.Now().Add(s.cfg.Tick))
	}
}

func (s *Service) setNextRun(t time.Time) {
	s.mu.Lock()
	s.nextRunAt = t
	s.mu.Unlock()
}

// StartRefresh starts a run in the background right away (admin "Rodar agora").
// retryMissing makes every image without a stored file due now. Returns false when a run is in progress.
func (s *Service) StartRefresh(force, retryMissing bool) bool {
	if !s.running.CompareAndSwap(false, true) {
		return false
	}
	if retryMissing {
		s.mu.Lock()
		for _, it := range s.cat.Items {
			for _, kind := range imageKinds(it) {
				if st := s.state.Images[imageKey(it.ID, kind)]; st != nil && (st.SHA256 == "" || !s.blobs.has(st.SHA256)) {
					st.NextCheckAt = time.Time{}
				}
			}
		}
		s.mu.Unlock()
	}
	go func() {
		defer s.running.Store(false)
		if _, err := s.refresh(context.Background(), force, "admin"); err != nil {
			log.Printf("[catalog] refresh (admin): %v", err)
		}
	}()
	return true
}

// ErrBusy = the same image is already being re-scraped.
var ErrBusy = errors.New("já está em andamento")

// RescrapeItem re-discovers the images of one item in the background (all kinds, or just `kind`).
// It ignores the schedule and records every source tried. Returns the kinds queued.
func (s *Service) RescrapeItem(id, kind string) ([]string, error) {
	it := s.cat.Get(id)
	if it == nil {
		return nil, ErrNotFound
	}
	kinds := imageKinds(it)
	if kind != "" {
		ok := false
		for _, k := range kinds {
			ok = ok || k == kind
		}
		if !ok {
			return nil, fmt.Errorf("tipo de imagem inválido para este item: %s", kind)
		}
		kinds = []string{kind}
	}
	s.mu.Lock()
	for _, k := range kinds {
		if _, busy := s.jobs[imageKey(id, k)]; busy {
			s.mu.Unlock()
			return nil, ErrBusy
		}
	}
	now := time.Now()
	for _, k := range kinds {
		s.jobs[imageKey(id, k)] = now
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		s.gcMu.RLock()
		for _, k := range kinds {
			s.checkImage(ctx, it, k, time.Now(), true)
		}
		s.gcMu.RUnlock()
		s.mu.Lock()
		for _, k := range kinds {
			delete(s.jobs, imageKey(id, k))
		}
		if err := saveState(filepath.Join(s.cfg.DataDir, "state.json"), s.state); err != nil {
			log.Printf("[catalog] save state: %v", err)
		}
		s.mu.Unlock()
		s.rebuildResponse()
	}()
	if s.syncJobs {
		<-done
	}
	return kinds, nil
}

func (s *Service) setProgress(phase string, done, total int, current string) {
	s.mu.Lock()
	s.progress = RunProgress{Phase: phase, Done: done, Total: total, Current: current}
	s.mu.Unlock()
}

// TriggerRefresh asks the background loop to run now (non-blocking).
func (s *Service) TriggerRefresh(force bool) {
	select {
	case s.trigger <- force:
	default:
	}
}

// Refresh checks due sources, mirrors changed files and scrapes missing images.
// force=true ignores schedules (still uses ETags, so unchanged data stays cheap).
func (s *Service) Refresh(ctx context.Context, force bool) (RunStats, error) {
	if !s.running.CompareAndSwap(false, true) {
		return RunStats{}, nil // single-flight: a run is already in progress
	}
	defer s.running.Store(false)
	trigger := "timer"
	if force {
		trigger = "force"
	}
	return s.refresh(ctx, force, trigger)
}

// refresh is one run; the caller holds s.running.
func (s *Service) refresh(ctx context.Context, force bool, trigger string) (RunStats, error) {
	now := time.Now()
	stats := RunStats{StartedAt: now, Trigger: trigger, Forced: force}
	defer s.setProgress("", 0, 0, "")

	// 1) one request per due source
	sources := s.cat.Sources()
	for i, ref := range sources {
		if ctx.Err() != nil {
			break
		}
		s.setProgress("sources", i, len(sources), ref.Repo)
		s.mu.Lock()
		prev := s.state.Sources[ref.Key]
		if prev == nil {
			prev = &SourceState{Key: ref.Key}
			s.state.Sources[ref.Key] = prev
		}
		due := force || prev.NextCheckAt.IsZero() || now.After(prev.NextCheckAt)
		snapshot := *prev
		s.mu.Unlock()
		if !due {
			stats.SkippedNotDueYet++
			continue
		}

		stats.SourcesChecked++
		rel, err := s.fetchRelease(ctx, ref, &snapshot)
		s.mu.Lock()
		prev.Requests++
		prev.CheckedAt = now
		switch {
		case errors.Is(err, errNotModified):
			stats.NotModified++
			prev.NotModified++
			prev.Failures, prev.LastError = 0, ""
			iv := nextInterval(s.cfg, time.Duration(prev.IntervalSec)*time.Second, false, 0)
			prev.IntervalSec = int64(iv / time.Second)
			prev.NextCheckAt = now.Add(jitter(iv))
		case err != nil:
			stats.Errors++
			prev.Failures++
			prev.LastError = err.Error()
			prev.NextCheckAt = now.Add(nextInterval(s.cfg, 0, false, prev.Failures))
		default:
			changed := !sameRelease(prev, rel)
			if changed {
				stats.SourcesChanged++
				prev.ChangedAt = now
			}
			prev.Tag, prev.ReleasePage, prev.PublishedAt, prev.Assets = rel.Tag, rel.ReleasePage, rel.PublishedAt, rel.Assets
			if rel.ETag != "" {
				prev.ETag = rel.ETag
			}
			prev.Failures, prev.LastError = 0, ""
			iv := nextInterval(s.cfg, time.Duration(prev.IntervalSec)*time.Second, changed, 0)
			prev.IntervalSec = int64(iv / time.Second)
			prev.NextCheckAt = now.Add(jitter(iv))
		}
		s.mu.Unlock()
	}

	// 2) resolve each item/platform from the cached releases (no network)
	s.mu.Lock()
	s.resolveAllLocked()
	s.mu.Unlock()
	s.rebuildResponse()

	// 3) mirror what changed
	if s.cfg.Mirror {
		s.setProgress("mirror", 0, 0, "")
		n, bytes := s.mirrorPending(ctx, now)
		stats.Mirrored, stats.MirrorBytes = n, bytes
	}

	// 4) images
	for i, it := range s.cat.Items {
		if ctx.Err() != nil {
			break
		}
		s.setProgress("images", i, len(s.cat.Items), it.ID)
		for _, kind := range imageKinds(it) {
			r := s.checkImage(ctx, it, kind, now, false)
			if !r.Checked {
				continue
			}
			stats.ImagesChecked++
			switch {
			case r.Revalidated:
				stats.ImagesRevalidated++
			case r.Found:
				stats.ImagesFound++
			default:
				stats.ImagesFailed++
			}
		}
	}

	// 5) garbage-collect unreferenced blobs, persist, publish
	s.setProgress("gc", 0, 0, "")
	s.gcMu.Lock()
	freed, _ := s.blobs.gc(s.referencedBlobs())
	s.gcMu.Unlock()
	stats.FreedBytes = freed
	stats.FinishedAt = time.Now()
	if ctx.Err() != nil {
		stats.Error = "interrompido: " + ctx.Err().Error()
	}
	s.mu.Lock()
	s.lastRun = stats
	s.state.Runs = append(s.state.Runs, stats)
	if len(s.state.Runs) > maxRuns {
		s.state.Runs = append([]RunStats(nil), s.state.Runs[len(s.state.Runs)-maxRuns:]...)
	}
	err := saveState(filepath.Join(s.cfg.DataDir, "state.json"), s.state)
	if err != nil {
		s.lastRun.Error = "estado não salvo: " + err.Error()
		s.state.Runs[len(s.state.Runs)-1].Error = s.lastRun.Error
		stats.Error = s.lastRun.Error
	}
	s.mu.Unlock()
	s.rebuildResponse()
	return stats, err
}

func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	return d + time.Duration(rand.Int64N(int64(d)/10+1)) // +0..10% spreads requests over time
}

// resolveAllLocked maps every item/platform to its current official file.
func (s *Service) resolveAllLocked() {
	for _, it := range s.cat.Items {
		for _, platform := range Platforms {
			key := resolvedKey(it.ID, platform)
			var next *Resolved
			if it.Release != nil && it.Release.Assets[platform] != "" {
				src := s.state.Sources[sourceKey(it.Release.Provider, it.Release.Host, it.Release.RepoFor(platform), it.Release.Tag)]
				if src != nil {
					if a, ok := PickAsset(src.Assets, it.Release.Assets[platform]); ok {
						next = &Resolved{Version: src.Tag, AssetName: a.Name, Size: a.Size, OfficialURL: a.URL, ReleasePage: src.ReleasePage, PublishedAt: src.PublishedAt}
					}
				}
			}
			if next == nil && it.DownloadURLs[platform] != "" {
				u := it.DownloadURLs[platform]
				next = &Resolved{AssetName: fileName(u), OfficialURL: u, ReleasePage: it.DownloadPage}
			}
			prev := s.state.Resolved[key]
			if next == nil {
				// keep the last known good value while the source is temporarily failing
				continue
			}
			if prev != nil && prev.OfficialURL != next.OfficialURL {
				next.PreviousURL = prev.OfficialURL
			} else if prev != nil {
				next.PreviousURL = prev.PreviousURL
			}
			s.state.Resolved[key] = next
		}
	}
}

func fileName(u string) string {
	u = strings.SplitN(strings.SplitN(u, "?", 2)[0], "#", 2)[0]
	if i := strings.LastIndex(u, "/"); i >= 0 {
		u = u[i+1:]
	}
	return u
}

// mirrorPending downloads official files that are not stored yet.
func (s *Service) mirrorPending(ctx context.Context, now time.Time) (int, int64) {
	type job struct{ url, name string }
	var jobs []job
	s.mu.Lock()
	selected := s.mirrorSelectionLocked()
	for _, r := range s.state.Resolved {
		if !selected[r.OfficialURL] {
			continue
		}
		m := s.state.Mirrors[r.OfficialURL]
		if m == nil {
			m = &MirrorState{URL: r.OfficialURL, Name: r.AssetName}
			s.state.Mirrors[r.OfficialURL] = m
		}
		if s.blobs.has(m.SHA256) || now.Before(m.NextAttemptAt) {
			continue
		}
		jobs = append(jobs, job{r.OfficialURL, r.AssetName})
	}
	s.mu.Unlock()

	var (
		wg    sync.WaitGroup
		sem   = make(chan struct{}, s.cfg.Concurrency)
		count atomic.Int64
		bytes atomic.Int64
	)
	for _, j := range jobs {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(j job) {
			defer wg.Done()
			defer func() { <-sem }()
			sha, size, _, _, _, err := s.downloadBlob(ctx, j.url, s.cfg.MaxMirrorBytes, nil)
			s.mu.Lock()
			defer s.mu.Unlock()
			m := s.state.Mirrors[j.url]
			if err != nil {
				m.Failures++
				m.LastError = err.Error()
				m.NextAttemptAt = now.Add(nextInterval(s.cfg, 0, false, m.Failures))
				if err == errTooLarge {
					m.NextAttemptAt = now.Add(30 * 24 * time.Hour)
				}
				return
			}
			m.SHA256, m.Size, m.MirroredAt, m.Failures, m.LastError = sha, size, time.Now(), 0, ""
			count.Add(1)
			bytes.Add(size)
		}(j)
	}
	wg.Wait()
	return int(count.Load()), bytes.Load()
}

// unknownMirrorSize is the budget estimate for a file whose size is not known yet.
const unknownMirrorSize = 64 << 20

// mirrorSelectionLocked picks which official files fit in the mirror: mirrored platforms
// only, each file under MaxMirrorBytes and, together, under MirrorTotalBytes (0 = no total
// limit). Current versions first (most downloaded, then already stored to avoid churn, then
// smaller); the previous version of a file (kept one cycle, never served by MirrorFile) only
// with whatever budget is left. Files left out still work: MirrorFile redirects to the
// official URL. Caller holds s.mu.
func (s *Service) mirrorSelectionLocked() map[string]bool {
	type cand struct {
		url       string
		size      int64
		downloads int64
		stored    bool
		previous  bool
	}
	seen := map[string]bool{}
	var cands []cand
	for key, r := range s.state.Resolved {
		platform := key[strings.LastIndex(key, "|")+1:]
		if r.OfficialURL == "" || seen[r.OfficialURL] || !s.cfg.MirrorPlatform[platform] || r.Size > s.cfg.MaxMirrorBytes {
			continue
		}
		seen[r.OfficialURL] = true
		c := cand{url: r.OfficialURL, size: r.Size}
		if m := s.state.Mirrors[r.OfficialURL]; m != nil {
			if m.Size > 0 {
				c.size = m.Size
			}
			c.downloads = m.Downloads
			c.stored = m.SHA256 != "" && s.blobs.has(m.SHA256)
		}
		if c.size <= 0 {
			c.size = unknownMirrorSize
		}
		cands = append(cands, c)
	}
	for key, r := range s.state.Resolved {
		platform := key[strings.LastIndex(key, "|")+1:]
		m := s.state.Mirrors[r.PreviousURL]
		if r.PreviousURL == "" || seen[r.PreviousURL] || !s.cfg.MirrorPlatform[platform] || m == nil || m.SHA256 == "" || !s.blobs.has(m.SHA256) {
			continue // a previous version is never downloaded, only kept while it fits
		}
		seen[r.PreviousURL] = true
		cands = append(cands, cand{url: r.PreviousURL, size: max(m.Size, 1), stored: true, previous: true})
	}
	sort.Slice(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.previous != b.previous {
			return b.previous
		}
		if a.downloads != b.downloads {
			return a.downloads > b.downloads
		}
		if a.stored != b.stored {
			return a.stored
		}
		if a.size != b.size {
			return a.size < b.size
		}
		return a.url < b.url
	})
	sel := map[string]bool{}
	var used int64
	for _, c := range cands {
		if s.cfg.MirrorTotalBytes > 0 && used+c.size > s.cfg.MirrorTotalBytes {
			continue // a smaller file further down may still fit
		}
		used += c.size
		sel[c.url] = true
	}
	return sel
}

// referencedBlobs = the files picked by mirrorSelectionLocked + images. Everything else
// (older versions, removed items, files over the budget) is garbage.
func (s *Service) referencedBlobs() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := map[string]bool{}
	for _, r := range s.state.Resolved {
		current[r.OfficialURL] = true
		if r.PreviousURL != "" {
			current[r.PreviousURL] = true
		}
	}
	selected := s.mirrorSelectionLocked()
	keep := map[string]bool{}
	for u, m := range s.state.Mirrors {
		if !current[u] {
			delete(s.state.Mirrors, u)
			continue
		}
		if !selected[u] {
			// Over the budget: drop the stored copy but keep counters and size for the next pick.
			m.SHA256, m.MirroredAt = "", time.Time{}
			continue
		}
		if m.SHA256 != "" {
			keep[m.SHA256] = true
		}
	}
	for _, img := range s.state.Images {
		if img.SHA256 != "" {
			keep[img.SHA256] = true
		}
	}
	return keep
}

// ---------------------------------------------------------------------------
// Public response (precomputed, served with ETag)
// ---------------------------------------------------------------------------

type livePlatform struct {
	Resolved
	MirrorURL string `json:"mirrorUrl,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
}

type liveImages struct {
	Logo  string `json:"logo,omitempty"`
	Cover string `json:"cover,omitempty"`
}

type liveInfo struct {
	Platforms map[string]livePlatform `json:"platforms"`
	Images    liveImages              `json:"images"`
}

func (s *Service) abs(p string) string { return s.cfg.PublicBaseURL + p }

func (s *Service) liveLocked(it *Item) liveInfo {
	info := liveInfo{Platforms: map[string]livePlatform{}}
	for _, platform := range Platforms {
		r := s.state.Resolved[resolvedKey(it.ID, platform)]
		if r == nil {
			continue
		}
		lp := livePlatform{Resolved: *r}
		lp.PreviousURL = ""
		if m := s.state.Mirrors[r.OfficialURL]; m != nil && m.SHA256 != "" && s.blobs.has(m.SHA256) {
			lp.MirrorURL = s.abs("/api/catalog/mirror/" + it.ID + "/" + platform)
			lp.SHA256 = m.SHA256
			if lp.Size == 0 {
				lp.Size = m.Size
			}
		}
		info.Platforms[platform] = lp
	}
	for _, kind := range imageKinds(it) {
		if img := s.state.Images[imageKey(it.ID, kind)]; img != nil && img.SHA256 != "" {
			u := s.abs("/api/catalog/images/" + img.SHA256)
			if kind == "logo" {
				info.Images.Logo = u
			} else {
				info.Images.Cover = u
			}
		}
	}
	return info
}

func (s *Service) rebuildResponse() {
	s.mu.Lock()
	ports, emus := []json.RawMessage{}, []json.RawMessage{}
	items := map[string][]byte{}
	for _, it := range s.cat.Items {
		var obj map[string]any
		if json.Unmarshal(it.Raw, &obj) != nil {
			continue
		}
		obj["live"] = s.liveLocked(it)
		b, _ := json.Marshal(obj)
		items[it.ID] = b
		if it.Kind == "port" {
			ports = append(ports, b)
		} else {
			emus = append(emus, b)
		}
	}
	updated := s.lastRun.FinishedAt
	s.mu.Unlock()

	body, _ := json.Marshal(map[string]any{
		"schemaVersion": s.cat.SchemaVersion,
		"updatedAt":     updated,
		"ports":         ports,
		"emulators":     emus,
		"emulatorPicks": s.cat.EmulatorPicks,
		"systemOrder":   s.cat.SystemOrder,
	})
	sum := sha256.Sum256(body)
	s.respMu.Lock()
	s.response, s.respETag, s.itemResp = body, `"`+hex.EncodeToString(sum[:8])+`"`, items
	s.respMu.Unlock()
}
