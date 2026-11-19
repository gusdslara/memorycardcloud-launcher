package catalog

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Image kinds the catalog wants for each item.
func imageKinds(it *Item) []string {
	if it.Kind == "port" {
		return []string{"cover", "logo"}
	}
	return []string{"logo"}
}

type imageCandidate struct {
	Source string // override | curated | steamgriddb | steam | website | wikipedia | github
	URL    string
	Header http.Header
	// find resolves the URL lazily (it costs requests): only called when every earlier candidate failed.
	// It explains an empty result for the attempt log.
	find func() (string, *lookupErr)
	// Detail describes a lazy candidate in the admin view (e.g. the Wikipedia title it looks up).
	Detail string
}

const libretroRaw = "https://raw.githubusercontent.com/libretro-thumbnails/"

// libretroMirror maps a libretro-thumbnails raw GitHub URL to the official thumbnails server.
// Many files in those repos are git symlinks, and raw.githubusercontent.com answers them with the
// target path as text/plain (not an image); thumbnails.libretro.com serves the real file.
func libretroMirror(u string) string {
	if !strings.HasPrefix(u, libretroRaw) {
		return ""
	}
	parts := strings.SplitN(strings.TrimPrefix(u, libretroRaw), "/", 3) // system, branch, path
	if len(parts) != 3 {
		return ""
	}
	system := strings.ReplaceAll(strings.ReplaceAll(parts[0], "_-_", " - "), "_", " ")
	return "https://thumbnails.libretro.com/" + url.PathEscape(system) + "/" + parts[2]
}

// preferredImages are the candidates the catalog itself provides (no lookups needed), best first.
func preferredImages(it *Item, kind string) []imageCandidate {
	var out []imageCandidate
	add := func(src, u string) {
		if u == "" {
			return
		}
		out = append(out, imageCandidate{Source: src, URL: u})
		if m := libretroMirror(u); m != "" {
			out = append(out, imageCandidate{Source: src, URL: m})
		}
	}
	if it.Images != nil {
		if kind == "logo" {
			add("override", it.Images.Logo)
		} else {
			add("override", it.Images.Cover)
		}
	}
	// Curated / build-time sources (box art from libretro-thumbnails, RecompLauncher, Steam, Wikipedia...): verified.
	if it.Art != nil {
		if kind == "cover" {
			for _, c := range it.Art.CoverRefs() {
				if c.Fit != "contain" {
					add("curated", c.URL)
				}
			}
		}
		if kind == "logo" && it.Kind == "emulator" {
			add("curated", it.Art.Logo)
		}
	}
	return out
}

// discoverImage lists candidate URLs, best first. Lookups (SteamGridDB, Wikipedia, websites) are lazy,
// so they only cost requests when the cheaper candidates failed. Once found, the URL is cached and only
// revalidated monthly.
func (s *Service) discoverImage(ctx context.Context, it *Item, kind string) []imageCandidate {
	out := preferredImages(it, kind)
	add := func(src, u string) {
		if u != "" {
			out = append(out, imageCandidate{Source: src, URL: u})
		}
	}
	lazy := func(src, detail string, f func() (string, *lookupErr)) {
		out = append(out, imageCandidate{Source: src, find: f, Detail: detail})
	}
	if s.cfg.SteamGridDBKey != "" && it.Kind == "port" {
		title := cleanArtTitle(it.ArtTitle())
		lazy("steamgriddb", "busca: "+title, func() (string, *lookupErr) { return s.steamGridDBLookup(ctx, title, kind) })
	}
	switch {
	case kind == "cover":
		if it.Art != nil && it.Art.SteamAppID > 0 {
			// Steam library capsule (600x900), the same art Steam shows in the library.
			add("steam", fmt.Sprintf("%s/steam/apps/%d/library_600x900.jpg", s.cfg.SteamCDN, it.Art.SteamAppID))
		}
		for _, title := range it.ArtSearchTitles() {
			title := title
			strict := title != it.WikiTitle // an explicit WikiTitle is trusted as is
			// Lead image of any license first (game covers are non-free, so the REST summary often omits them).
			lazy("wikipedia", "artigo: "+title, func() (string, *lookupErr) { return s.wikipediaPageImageLookup(ctx, title, strict) })
			lazy("wikipedia", "resumo do artigo: "+title, func() (string, *lookupErr) { return s.wikipediaImageLookup(ctx, title, strict) })
		}
		if it.Art != nil {
			// icons / landscape images as a last resort before the generated cover
			for _, c := range it.Art.CoverRefs() {
				if c.Fit == "contain" {
					add("curated", c.URL)
				}
			}
		}
	case it.Kind == "emulator":
		// Emulator logos: the project's own site icon is the most faithful, then Wikipedia, then the GitHub org avatar.
		if it.WebsiteURL != "" {
			lazy("website", "ícone do site "+it.WebsiteURL, func() (string, *lookupErr) { return s.websiteIconLookup(ctx, it.WebsiteURL) })
		}
		if it.WikiTitle != "" {
			lazy("wikipedia", "artigo: "+it.WikiTitle, func() (string, *lookupErr) { return s.wikipediaImageLookup(ctx, it.WikiTitle, false) })
		}
		if owner := it.GitHubOwner(); owner != "" {
			add("github", fmt.Sprintf("%s/%s.png?size=256", s.cfg.GitHubWeb, owner))
		}
	default: // port logo = the team/org behind the port
		if owner := it.GitHubOwner(); owner != "" {
			add("github", fmt.Sprintf("%s/%s.png?size=256", s.cfg.GitHubWeb, owner))
		}
		if it.WebsiteURL != "" {
			lazy("website", "ícone do site "+it.WebsiteURL, func() (string, *lookupErr) { return s.websiteIconLookup(ctx, it.WebsiteURL) })
		}
	}
	return out
}

var notAGameRE = regexp.MustCompile(`(?i)franchise|series|character|mascot|company|film|novel|game engine|disambiguation`)

// aboutAGame tells whether a Wikipedia short description is about a single game
// ("1996 video game"), not a franchise, character or anything else with the same name.
// Pages without a description are accepted (older/smaller articles often have none).
func aboutAGame(desc string) bool {
	if desc == "" {
		return true
	}
	return strings.Contains(strings.ToLower(desc), "game") && !notAGameRE.MatchString(desc)
}

// wikipediaImage reads the REST summary (free images only). strict = only articles about a game.
func (s *Service) wikipediaImage(ctx context.Context, title string, strict bool) string {
	u, _ := s.wikipediaImageLookup(ctx, title, strict)
	return u
}

func (s *Service) wikipediaImageLookup(ctx context.Context, title string, strict bool) (string, *lookupErr) {
	if title == "" {
		return "", miss(ResultNoMatch, "sem título para buscar")
	}
	u := s.cfg.WikipediaAPI + "/page/summary/" + url.PathEscape(strings.ReplaceAll(title, " ", "_")) + "?redirect=true"
	var body struct {
		Type          string                  `json:"type"`
		Description   string                  `json:"description"`
		Thumbnail     struct{ Source string } `json:"thumbnail"`
		OriginalImage struct {
			Source string
			Width  int
		} `json:"originalimage"`
	}
	if e := s.getJSON(ctx, u, nil, 1<<20, &body); e != nil {
		if e.Result == ResultNoMatch {
			e.Detail = "artigo \"" + title + "\" não existe"
		}
		return "", e
	}
	if body.Type == "disambiguation" {
		return "", miss(ResultRejected, "\"%s\" é página de desambiguação", title)
	}
	if strict && !aboutAGame(body.Description) {
		return "", miss(ResultRejected, "\"%s\" não é sobre um jogo (%s)", title, body.Description)
	}
	// Original is best unless it is huge; the thumbnail is small (~320px).
	if body.OriginalImage.Source != "" && body.OriginalImage.Width > 0 && body.OriginalImage.Width <= 1600 {
		return stripQuery(body.OriginalImage.Source), nil
	}
	if body.Thumbnail.Source == "" {
		return "", miss(ResultNoMatch, "artigo \"%s\" sem imagem livre", title)
	}
	return stripQuery(body.Thumbnail.Source), nil
}

// wikipediaPageImage uses the action API with pilicense=any, which returns non-free lead images
// (box art) that the REST summary leaves out. Disambiguation pages never count.
func (s *Service) wikipediaPageImage(ctx context.Context, title string, strict bool) string {
	u, _ := s.wikipediaPageImageLookup(ctx, title, strict)
	return u
}

func (s *Service) wikipediaPageImageLookup(ctx context.Context, title string, strict bool) (string, *lookupErr) {
	if s.cfg.WikipediaActionAPI == "" {
		return "", miss(ResultNoMatch, "API de busca da Wikipedia não configurada")
	}
	if title == "" {
		return "", miss(ResultNoMatch, "sem título para buscar")
	}
	q := url.Values{
		"action": {"query"}, "format": {"json"}, "formatversion": {"2"}, "redirects": {"1"},
		"prop": {"pageimages|pageprops|description"}, "ppprop": {"disambiguation"},
		"piprop": {"original|thumbnail"}, "pithumbsize": {"600"}, "pilicense": {"any"},
		"titles": {title},
	}
	var body struct {
		Query struct {
			Pages []struct {
				Missing     bool              `json:"missing"`
				Description string            `json:"description"`
				PageProps   map[string]string `json:"pageprops"`
				Original    struct {
					Source string
					Width  int
				} `json:"original"`
				Thumbnail struct{ Source string } `json:"thumbnail"`
			} `json:"pages"`
		} `json:"query"`
	}
	if e := s.getJSON(ctx, s.cfg.WikipediaActionAPI+"?"+q.Encode(), nil, 1<<20, &body); e != nil {
		return "", e
	}
	if len(body.Query.Pages) == 0 {
		return "", miss(ResultNoMatch, "artigo \"%s\" não existe", title)
	}
	p := body.Query.Pages[0]
	if p.Missing {
		return "", miss(ResultNoMatch, "artigo \"%s\" não existe", title)
	}
	if _, disamb := p.PageProps["disambiguation"]; disamb {
		return "", miss(ResultRejected, "\"%s\" é página de desambiguação", title)
	}
	if strict && !aboutAGame(p.Description) {
		return "", miss(ResultRejected, "\"%s\" não é sobre um jogo (%s)", title, p.Description)
	}
	src := p.Original.Source
	if p.Thumbnail.Source != "" && (src == "" || p.Original.Width > 1600) {
		src = p.Thumbnail.Source
	}
	if src == "" {
		return "", miss(ResultNoMatch, "artigo \"%s\" sem imagem principal", title)
	}
	return stripQuery(src), nil
}

// stripQuery drops tracking parameters (?utm_source=...) the API now appends to upload.wikimedia.org URLs.
func stripQuery(u string) string {
	if strings.Contains(u, "wikimedia.org/") {
		if i := strings.IndexByte(u, '?'); i >= 0 {
			return u[:i]
		}
	}
	return u
}

var (
	linkTagRE = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	metaTagRE = regexp.MustCompile(`(?is)<meta\b[^>]*>`)
	attrRE    = regexp.MustCompile(`(?is)([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')`)
)

func attrs(tag string) map[string]string {
	m := map[string]string{}
	for _, a := range attrRE.FindAllStringSubmatch(tag, -1) {
		v := a[3]
		if v == "" {
			v = a[4]
		}
		m[strings.ToLower(a[1])] = v
	}
	return m
}

// pickIcon returns the best square icon declared by a page (apple-touch-icon > largest icon > og:image).
func pickIcon(html string, base *url.URL) string {
	best, bestScore := "", -1
	for _, tag := range linkTagRE.FindAllString(html, -1) {
		a := attrs(tag)
		rel := strings.ToLower(a["rel"])
		if a["href"] == "" || !strings.Contains(rel, "icon") {
			continue
		}
		score := 1
		if strings.Contains(rel, "apple-touch-icon") {
			score = 500
		}
		if sz := a["sizes"]; sz != "" {
			if n, err := strconv.Atoi(strings.SplitN(strings.ToLower(sz), "x", 2)[0]); err == nil {
				score += n
			}
		}
		if strings.HasSuffix(strings.ToLower(a["href"]), ".svg") {
			score += 300 // vector scales to any size
		}
		if strings.HasSuffix(strings.ToLower(a["href"]), ".ico") {
			score -= 50
		}
		if score > bestScore {
			best, bestScore = a["href"], score
		}
	}
	if best == "" {
		for _, tag := range metaTagRE.FindAllString(html, -1) {
			a := attrs(tag)
			if strings.EqualFold(a["property"], "og:image") && a["content"] != "" {
				best = a["content"]
				break
			}
		}
	}
	if best == "" {
		return ""
	}
	ref, err := url.Parse(best)
	if err != nil {
		return ""
	}
	return base.ResolveReference(ref).String()
}

func (s *Service) websiteIcon(ctx context.Context, site string) string {
	u, _ := s.websiteIconLookup(ctx, site)
	return u
}

func (s *Service) websiteIconLookup(ctx context.Context, site string) (string, *lookupErr) {
	base, err := url.Parse(site)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") {
		return "", miss(ResultError, "URL do site inválida")
	}
	req, err := s.newRequest(ctx, http.MethodGet, site)
	if err != nil {
		return "", miss(ResultError, "URL do site inválida")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		r, _, d := classify(err)
		return "", miss(r, "%s", d)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		res := ResultHTTP
		if isRateLimited(resp) {
			res = ResultRateLimited
		}
		return "", &lookupErr{Result: res, Status: resp.StatusCode, Detail: "site respondeu " + resp.Status}
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "html") {
		return "", miss(ResultNoMatch, "o site não é uma página HTML")
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512<<10))
	if resp.Request != nil && resp.Request.URL != nil {
		base = resp.Request.URL // after redirects
	}
	if icon := pickIcon(string(body), base); icon != "" {
		return icon, nil
	}
	return "", miss(ResultNoMatch, "a página não declara ícone nem og:image")
}

func (s *Service) steamGridDBLookup(ctx context.Context, title, kind string) (string, *lookupErr) {
	if title == "" {
		return "", miss(ResultNoMatch, "sem título para buscar")
	}
	hdr := http.Header{"Authorization": {"Bearer " + s.cfg.SteamGridDBKey}}
	var search struct {
		Data []struct{ ID int } `json:"data"`
	}
	if e := s.getJSON(ctx, s.cfg.SteamGridDBAPI+"/search/autocomplete/"+url.PathEscape(title), hdr, 2<<20, &search); e != nil {
		return "", e
	}
	if len(search.Data) == 0 {
		return "", miss(ResultNoMatch, "nenhum jogo \"%s\" no SteamGridDB", title)
	}
	endpoint := fmt.Sprintf("%s/grids/game/%d?dimensions=600x900", s.cfg.SteamGridDBAPI, search.Data[0].ID)
	what := "grid 600x900"
	if kind == "logo" {
		endpoint = fmt.Sprintf("%s/logos/game/%d", s.cfg.SteamGridDBAPI, search.Data[0].ID)
		what = "logo"
	}
	var art struct {
		Data []struct{ URL string } `json:"data"`
	}
	if e := s.getJSON(ctx, endpoint, hdr, 2<<20, &art); e != nil {
		return "", e
	}
	if len(art.Data) == 0 || art.Data[0].URL == "" {
		return "", miss(ResultNoMatch, "\"%s\" está no SteamGridDB, mas sem %s", title, what)
	}
	return art.Data[0].URL, nil
}

// imageCheck is the outcome of one checkImage call.
type imageCheck struct {
	Checked     bool // the image was due and was looked at
	Found       bool // an image is stored (new or revalidated)
	Revalidated bool // the cached image answered 304 / was re-downloaded from the same URL
}

// refreshImage makes sure item/kind has a stored image. Returns true when the state changed.
func (s *Service) refreshImage(ctx context.Context, it *Item, kind string, now time.Time) bool {
	return s.checkImage(ctx, it, kind, now, false).Checked
}

// checkImage looks for item/kind's image. force = ignore the schedule and re-discover every source
// (the admin "Raspar de novo"); a stored image is kept when nothing better is found.
// Every source tried is recorded in ImageState.Attempts (why it failed, HTTP status, time).
func (s *Service) checkImage(ctx context.Context, it *Item, kind string, now time.Time, force bool) imageCheck {
	s.mu.Lock()
	st := s.state.Images[imageKey(it.ID, kind)]
	if st == nil {
		st = &ImageState{ItemID: it.ID, Kind: kind}
		s.state.Images[imageKey(it.ID, kind)] = st
	}
	// The catalog's own best candidate (override/curated). When a new catalog changes it, re-discover now
	// instead of keeping an older, worse source (e.g. a Wikipedia logo) until the monthly revalidation.
	preferred := ""
	if pref := preferredImages(it, kind); len(pref) > 0 {
		preferred = pref[0].URL
	}
	prefChanged := preferred != "" && st.SourceURL != preferred && st.Preferred != preferred
	due := force || st.NextCheckAt.IsZero() || now.After(st.NextCheckAt) || (st.SHA256 != "" && !s.blobs.has(st.SHA256)) || prefChanged
	cached := *st
	s.mu.Unlock()
	if !due {
		return imageCheck{}
	}

	var log attemptLog
	try := func(c imageCandidate, etag string) (ImageState, bool) {
		start := time.Now()
		h := http.Header{}
		if etag != "" && s.blobs.has(cached.SHA256) {
			h.Set("If-None-Match", etag)
		}
		sha, _, ctype, newTag, notMod, err := s.downloadBlob(ctx, c.URL, s.cfg.MaxImageBytes, h)
		a := ImageAttempt{At: start, Source: c.Source, URL: c.URL, Ms: time.Since(start).Milliseconds()}
		switch {
		case notMod:
			a.Result, a.Status = ResultNotModified, http.StatusNotModified
			log.add(a)
			out := cached
			out.FetchedAt, out.NextCheckAt, out.Failures, out.LastError = now, now.Add(s.cfg.ImageInterval), 0, ""
			return out, true
		case err != nil:
			a.Result, a.Status, a.Detail = classify(err)
			log.add(a)
			return ImageState{}, false
		case !strings.HasPrefix(strings.ToLower(ctype), "image/"):
			a.Result, a.Status, a.Detail = ResultNotImage, http.StatusOK, "content-type: "+ctype
			if ctype == "" {
				a.Detail = "sem content-type"
			}
			log.add(a)
			return ImageState{}, false
		}
		a.Result, a.Status = ResultOK, http.StatusOK
		log.add(a)
		return ImageState{ItemID: it.ID, Kind: kind, Source: c.Source, SourceURL: c.URL, SHA256: sha, ContentType: ctype,
			ETag: newTag, FetchedAt: now, NextCheckAt: now.Add(s.cfg.ImageInterval)}, true
	}

	var result ImageState
	ok := false
	revalidated := false
	tried := map[string]bool{}
	// 1) revalidate what we already know (cheap, usually a 304)
	if cached.SourceURL != "" && !prefChanged && !force {
		tried[cached.SourceURL] = true
		result, ok = try(imageCandidate{Source: cached.Source, URL: cached.SourceURL}, cached.ETag)
		revalidated = ok
	}
	// 2) otherwise discover sources
	if !ok {
		for _, c := range s.discoverImage(ctx, it, kind) {
			if ctx.Err() != nil {
				break
			}
			if c.URL == "" && c.find != nil {
				start := time.Now()
				u, e := c.find()
				if u == "" {
					a := ImageAttempt{At: start, Source: c.Source, Result: ResultNoMatch, Detail: c.Detail, Ms: time.Since(start).Milliseconds()}
					if e != nil {
						a.Result, a.Status = e.Result, e.Status
						if e.Detail != "" {
							a.Detail = e.Detail
						}
					}
					log.add(a)
					continue
				}
				c.URL = u
			}
			if c.URL == "" || tried[c.URL] {
				continue
			}
			tried[c.URL] = true
			if result, ok = try(c, ""); ok {
				revalidated = result.SourceURL == cached.SourceURL && result.SHA256 == cached.SHA256
				break
			}
		}
	}
	// 3) forced re-scrape found nothing: keep (and revalidate) the image we already had
	if !ok && force && cached.SourceURL != "" && !tried[cached.SourceURL] {
		result, ok = try(imageCandidate{Source: cached.Source, URL: cached.SourceURL}, cached.ETag)
		revalidated = ok
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if ok {
		*st = result
		st.Preferred = preferred
		st.Attempts, st.CheckedAt = log.bounded(), now
		return imageCheck{Checked: true, Found: true, Revalidated: revalidated}
	}
	st.Preferred = preferred
	st.Failures++
	st.LastError = fmt.Sprintf("nenhuma imagem encontrada (%d fontes tentadas)", len(log))
	st.Attempts, st.CheckedAt = log.bounded(), now
	st.NextCheckAt = now.Add(nextInterval(s.cfg, 0, false, st.Failures) * 4)
	return imageCheck{Checked: true, Found: st.SHA256 != "" && s.blobs.has(st.SHA256)}
}
