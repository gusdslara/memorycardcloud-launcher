package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Same rules as pickAsset() in src/lib/services/installPlanner.ts and installer.rs.
var noiseRE = regexp.MustCompile(`(?i)\.(sig|asc|sha\d*|sha\d*sum|md5|zsync|pdb|dsym|txt|json)$|symbols|debug|-dbg-|source|src\.|sourceonly`)

// PickAsset returns the first non-noise asset whose name matches pattern (case-insensitive).
func PickAsset(assets []Asset, pattern string) (Asset, bool) {
	if pattern == "" {
		return Asset{}, false
	}
	re, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return Asset{}, false
	}
	for _, a := range assets {
		if noiseRE.MatchString(a.Name) {
			continue
		}
		if re.MatchString(a.Name) {
			return a, true
		}
	}
	return Asset{}, false
}

var errNotModified = errors.New("not modified")

type apiRelease struct {
	TagName     string    `json:"tag_name"`
	HTMLURL     string    `json:"html_url"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []struct {
		Name               string    `json:"name"`
		BrowserDownloadURL string    `json:"browser_download_url"`
		Size               int64     `json:"size"`
		UpdatedAt          time.Time `json:"updated_at"`
	} `json:"assets"`
}

type fetchedRelease struct {
	ETag        string
	Tag         string
	ReleasePage string
	PublishedAt time.Time
	Assets      []Asset
}

func (r *apiRelease) toFetched(etag string) *fetchedRelease {
	out := &fetchedRelease{ETag: etag, Tag: r.TagName, ReleasePage: r.HTMLURL, PublishedAt: r.PublishedAt}
	for _, a := range r.Assets {
		out.Assets = append(out.Assets, Asset{Name: a.Name, URL: a.BrowserDownloadURL, Size: a.Size, UpdatedAt: a.UpdatedAt})
	}
	return out
}

func (s *Service) newRequest(ctx context.Context, method, u string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", s.cfg.UserAgent)
	return req, nil
}

// fetchRelease asks the upstream for the release of `ref`, using `prev` for conditional requests.
func (s *Service) fetchRelease(ctx context.Context, ref SourceRef, prev *SourceState) (*fetchedRelease, error) {
	if ref.Provider == "gitea" {
		return s.fetchGitea(ctx, ref, prev)
	}
	rel, err := s.fetchGitHubAPI(ctx, ref, prev)
	if err == nil || errors.Is(err, errNotModified) {
		return rel, err
	}
	// Rate-limited or API unavailable: the public HTML pages are not rate-limited the same way.
	rel2, err2 := s.fetchGitHubHTML(ctx, ref, prev)
	if errors.Is(err2, errNotModified) {
		return nil, errNotModified
	}
	if err2 != nil {
		return nil, fmt.Errorf("api: %v; html: %w", err, err2)
	}
	return rel2, nil
}

func (s *Service) fetchGitHubAPI(ctx context.Context, ref SourceRef, prev *SourceState) (*fetchedRelease, error) {
	u := fmt.Sprintf("%s/repos/%s/releases/latest", s.cfg.GitHubAPI, ref.Repo)
	if ref.Tag != "" {
		u = fmt.Sprintf("%s/repos/%s/releases/tags/%s", s.cfg.GitHubAPI, ref.Repo, url.PathEscape(ref.Tag))
	}
	req, err := s.newRequest(ctx, http.MethodGet, u)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if s.cfg.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.GitHubToken)
	}
	if prev != nil && prev.ETag != "" && len(prev.Assets) > 0 {
		req.Header.Set("If-None-Match", prev.ETag) // 304s don't count against the rate limit
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotModified:
		return nil, errNotModified
	case resp.StatusCode != http.StatusOK:
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("GitHub API %s", resp.Status)
	}
	var r apiRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&r); err != nil {
		return nil, err
	}
	return r.toFetched(resp.Header.Get("ETag")), nil
}

var (
	tagFromURL = regexp.MustCompile(`/([^/]+/[^/]+)/releases/tag/([^/?#]+)`)
	assetHref  = regexp.MustCompile(`href="(/[^"]+/releases/download/[^"]+)"`)
)

func (s *Service) fetchGitHubHTML(ctx context.Context, ref SourceRef, prev *SourceState) (*fetchedRelease, error) {
	repo, tag := ref.Repo, ref.Tag
	if tag == "" {
		// Read the redirect target only (don't download the page).
		req, err := s.newRequest(ctx, http.MethodHead, fmt.Sprintf("%s/%s/releases/latest", s.cfg.GitHubWeb, ref.Repo))
		if err != nil {
			return nil, err
		}
		resp, err := s.noRedirectClient().Do(req)
		if err != nil {
			return nil, err
		}
		resp.Body.Close()
		m := tagFromURL.FindStringSubmatch(resp.Header.Get("Location"))
		if m == nil {
			return nil, fmt.Errorf("nenhuma release publicada em %s", ref.Repo)
		}
		repo = m[1]
		tag, _ = url.PathUnescape(m[2])
		if prev != nil && prev.Tag == tag && len(prev.Assets) > 0 {
			return nil, errNotModified // same tag: nothing else to fetch
		}
	}
	req, err := s.newRequest(ctx, http.MethodGet, fmt.Sprintf("%s/%s/releases/expanded_assets/%s", s.cfg.GitHubWeb, repo, url.PathEscape(tag)))
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	out := &fetchedRelease{Tag: tag, ReleasePage: fmt.Sprintf("%s/%s/releases/tag/%s", s.cfg.GitHubWeb, repo, url.PathEscape(tag))}
	seen := map[string]bool{}
	for _, m := range assetHref.FindAllStringSubmatch(string(body), -1) {
		p := m[1]
		if seen[p] {
			continue
		}
		seen[p] = true
		name, _ := url.PathUnescape(p[strings.LastIndex(p, "/")+1:])
		out.Assets = append(out.Assets, Asset{Name: name, URL: s.cfg.GitHubWeb + p})
	}
	if len(out.Assets) == 0 {
		return nil, fmt.Errorf("release %s de %s sem arquivos", tag, repo)
	}
	return out, nil
}

func (s *Service) fetchGitea(ctx context.Context, ref SourceRef, prev *SourceState) (*fetchedRelease, error) {
	if ref.Host == "" {
		return nil, errors.New("fonte gitea sem host")
	}
	base := "https://" + ref.Host
	if s.cfg.GiteaBaseOverride != "" {
		base = s.cfg.GiteaBaseOverride
	}
	u := fmt.Sprintf("%s/api/v1/repos/%s/releases/latest", base, ref.Repo)
	if ref.Tag != "" {
		u = fmt.Sprintf("%s/api/v1/repos/%s/releases/tags/%s", base, ref.Repo, url.PathEscape(ref.Tag))
	}
	req, err := s.newRequest(ctx, http.MethodGet, u)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if prev != nil && prev.ETag != "" && len(prev.Assets) > 0 {
		req.Header.Set("If-None-Match", prev.ETag)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, errNotModified
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s respondeu %s", ref.Host, resp.Status)
	}
	var r apiRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&r); err != nil {
		return nil, err
	}
	return r.toFetched(resp.Header.Get("ETag")), nil
}

func (s *Service) noRedirectClient() *http.Client {
	c := *s.client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}

// sameRelease tells whether a fetched release is identical to what we already have.
func sameRelease(prev *SourceState, rel *fetchedRelease) bool {
	if prev == nil || prev.Tag != rel.Tag || len(prev.Assets) != len(rel.Assets) {
		return false
	}
	for i := range rel.Assets {
		if prev.Assets[i].Name != rel.Assets[i].Name || prev.Assets[i].URL != rel.Assets[i].URL {
			return false
		}
	}
	return true
}

// nextInterval implements the adaptive schedule:
// changed → back to the minimum; unchanged → double (up to max); error → exponential backoff.
func nextInterval(cfg Config, prev time.Duration, changed bool, failures int) time.Duration {
	if failures > 0 {
		d := cfg.RetryBase << uint(min(failures-1, 6))
		return min(d, 24*time.Hour)
	}
	if changed || prev <= 0 {
		return cfg.MinInterval
	}
	return min(prev*2, cfg.MaxInterval)
}
