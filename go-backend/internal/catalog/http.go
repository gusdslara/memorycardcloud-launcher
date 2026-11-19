package catalog

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Handler serves the JSON endpoints:
//
//	GET  /api/catalog                 full catalog + live data (ETag, 304)
//	GET  /api/catalog/items/{id}      one item
//	GET  /api/catalog/status          scraper health
//	POST /api/catalog/refresh         trigger a run (header X-Admin-Token)
//	GET  /api/catalog/mirror/{id}/{platform}  mirrored file (or 302 to official)
//	GET  /api/catalog/images/{sha}    scraped image
//
// Under Fiber, mount the JSON routes with adaptor and the two file routes with
// c.SendFile (see main.go), so large files are streamed instead of buffered.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/catalog", s.handleCatalog)
	mux.HandleFunc("GET /api/catalog/items/{id}", s.handleItem)
	mux.HandleFunc("GET /api/catalog/status", s.handleStatus)
	mux.HandleFunc("POST /api/catalog/refresh", s.handleRefresh)
	mux.HandleFunc("GET /api/catalog/mirror/{id}/{platform}", func(w http.ResponseWriter, r *http.Request) {
		f, err := s.MirrorFile(r.PathValue("id"), r.PathValue("platform"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if f.Path == "" {
			http.Redirect(w, r, f.RedirectURL, http.StatusFound)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+f.FileName+`"`)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, f.Path)
	})
	mux.HandleFunc("GET /api/catalog/images/{sha}", func(w http.ResponseWriter, r *http.Request) {
		f, err := s.ImageFile(r.PathValue("sha"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		for k, v := range f.Headers() {
			w.Header().Set(k, v)
		}
		http.ServeFile(w, r, f.Path)
	})
	return mux
}

func (s *Service) handleCatalog(w http.ResponseWriter, r *http.Request) {
	s.respMu.RLock()
	body, etag := s.response, s.respETag
	s.respMu.RUnlock()
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600")
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(body)
}

func (s *Service) handleItem(w http.ResponseWriter, r *http.Request) {
	s.respMu.RLock()
	body := s.itemResp[r.PathValue("id")]
	s.respMu.RUnlock()
	if body == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write(body)
}

type statusResponse struct {
	Running  bool                    `json:"running"`
	LastRun  RunStats                `json:"lastRun"`
	Items    int                     `json:"items"`
	Sources  int                     `json:"sources"`
	Mirrored int                     `json:"mirrored"`
	Images   int                     `json:"images"`
	Problems map[string]string       `json:"problems,omitempty"`
	Next     map[string]time.Time    `json:"nextChecks,omitempty"`
	Stats    map[string]*SourceState `json:"-"`
}

func (s *Service) Status() statusResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := statusResponse{Running: s.running.Load(), LastRun: s.lastRun, Items: len(s.cat.Items), Problems: map[string]string{}, Next: map[string]time.Time{}}
	st.Sources = len(s.state.Sources)
	for k, src := range s.state.Sources {
		if src.LastError != "" {
			st.Problems[k] = src.LastError
		}
		st.Next[k] = src.NextCheckAt
	}
	for _, m := range s.state.Mirrors {
		if m.SHA256 != "" {
			st.Mirrored++
		}
	}
	for _, img := range s.state.Images {
		if img.SHA256 != "" {
			st.Images++
		}
	}
	return st
}

func (s *Service) handleStatus(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(s.Status())
}

// CheckAdmin validates the X-Admin-Token header against CATALOG_ADMIN_TOKEN.
func (s *Service) CheckAdmin(token string) bool {
	return s.cfg.AdminToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) == 1
}

func (s *Service) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.CheckAdmin(r.Header.Get("X-Admin-Token")) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.TriggerRefresh(r.URL.Query().Get("force") == "1")
	w.WriteHeader(http.StatusAccepted)
}

// File describes a file to send. Path empty → redirect to RedirectURL.
type File struct {
	Path        string
	FileName    string
	ContentType string
	RedirectURL string
}

// Headers returns safe response headers for scraped images (SVGs are sandboxed).
func (f File) Headers() map[string]string {
	h := map[string]string{
		"Content-Type":           f.ContentType,
		"Cache-Control":          "public, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	}
	if strings.Contains(f.ContentType, "svg") {
		h["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
	}
	return h
}

var ErrNotFound = errors.New("não encontrado")

// MirrorFile returns the stored copy of an item's file, or a redirect to the
// official URL when it is not mirrored (the link always works).
func (s *Service) MirrorFile(id, platform string) (File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.state.Resolved[resolvedKey(id, platform)]
	if r == nil {
		return File{}, ErrNotFound
	}
	m := s.state.Mirrors[r.OfficialURL]
	if m == nil || m.SHA256 == "" || !s.blobs.has(m.SHA256) {
		return File{RedirectURL: r.OfficialURL}, nil
	}
	m.Downloads++
	name := strings.NewReplacer(`"`, "", "\n", "", "\r", "").Replace(r.AssetName)
	return File{Path: s.blobs.path(m.SHA256), FileName: name, ContentType: "application/octet-stream"}, nil
}

func (s *Service) ImageFile(sha string) (File, error) {
	if len(sha) != 64 || strings.ContainsAny(sha, "./\\") {
		return File{}, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, img := range s.state.Images {
		if img.SHA256 == sha && s.blobs.has(sha) {
			return File{Path: s.blobs.path(sha), ContentType: img.ContentType}, nil
		}
	}
	return File{}, ErrNotFound
}
