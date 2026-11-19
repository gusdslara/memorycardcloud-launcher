// Package gdrivetest is an in-memory Google Drive (files, folders, resumable uploads, media
// with Range, about, OAuth token endpoint) with fault injection, for tests of the backup flow.
package gdrivetest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"go-backend/internal/gdrive"
)

const folderMime = "application/vnd.google-apps.folder"

type File struct {
	ID       string
	Name     string
	Mime     string
	Parents  []string
	Data     []byte
	AppProps map[string]string
}

type session struct {
	meta File
	size int64
	data []byte
}

type fault struct {
	status  int
	times   int
	partial bool // chunk faults: keep half of the chunk before failing
}

type Server struct {
	*httptest.Server
	mu         sync.Mutex
	Files      map[string]*File
	sessions   map[string]*session
	faults     map[string]*fault
	next       int
	token      string
	TokenCalls int
	Limit      int64
	Requests   map[string]int
}

// Start launches the fake and points the gdrive package at it (restored on cleanup).
func Start(t *testing.T) *Server {
	t.Helper()
	s := &Server{Files: map[string]*File{}, sessions: map[string]*session{}, faults: map[string]*fault{},
		Limit: 5 << 40, Requests: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	oldAPI, oldUp, oldTok := gdrive.DriveAPI, gdrive.DriveUploadAPI, gdrive.TokenEndpoint
	oldChunk, oldBase, oldRPS := gdrive.ChunkSize, gdrive.BaseBackoff, gdrive.RequestsPerSecond
	gdrive.DriveAPI = s.URL + "/drive/v3"
	gdrive.DriveUploadAPI = s.URL + "/upload/drive/v3"
	gdrive.TokenEndpoint = s.URL + "/token"
	gdrive.ChunkSize = 256 << 10
	gdrive.BaseBackoff = time.Millisecond
	gdrive.RequestsPerSecond = 0
	t.Setenv("GOOGLE_CLIENT_ID", "test-client")
	t.Setenv("GOOGLE_CLIENT_SECRET", "test-secret")
	t.Cleanup(func() {
		s.Close()
		gdrive.DriveAPI, gdrive.DriveUploadAPI, gdrive.TokenEndpoint = oldAPI, oldUp, oldTok
		gdrive.ChunkSize, gdrive.BaseBackoff, gdrive.RequestsPerSecond = oldChunk, oldBase, oldRPS
	})
	return s
}

// Fail makes the next `times` requests of op answer status. Ops: token, list, create, patch,
// delete, media, session (start resumable), chunk, about.
func (s *Server) Fail(op string, status, times int, partial bool) {
	s.mu.Lock()
	s.faults[op] = &fault{status: status, times: times, partial: partial}
	s.mu.Unlock()
}

// ExpireToken invalidates the current access token (next call gets 401).
func (s *Server) ExpireToken() {
	s.mu.Lock()
	s.token = "expired"
	s.mu.Unlock()
}

func (s *Server) take(op string) *fault {
	f := s.faults[op]
	if f == nil || f.times <= 0 {
		return nil
	}
	f.times--
	return f
}

func (s *Server) newID() string {
	s.next++
	return fmt.Sprintf("f%04d", s.next)
}

func jsonOut(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiErr(w http.ResponseWriter, status int, reason string) {
	jsonOut(w, status, map[string]any{"error": map[string]any{"code": status, "message": reason,
		"errors": []map[string]string{{"reason": reason}}}})
}

func reasonFor(status int) string {
	switch status {
	case 403:
		return "userRateLimitExceeded"
	case 429:
		return "rateLimitExceeded"
	case 401:
		return "authError"
	}
	return "backendError"
}

func (s *Server) fileJSON(f *File) map[string]any {
	return map[string]any{"id": f.ID, "name": f.Name, "mimeType": f.Mime, "size": strconv.Itoa(len(f.Data)),
		"md5Checksum": md5hex(f.Data), "parents": f.Parents}
}

var (
	reName   = regexp.MustCompile(`name='((?:[^'\\]|\\.)*)'`)
	reParent = regexp.MustCompile(`'([^']+)' in parents`)
)

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := r.URL.Path

	if path == "/token" {
		s.Requests["token"]++
		if f := s.take("token"); f != nil {
			jsonOut(w, f.status, map[string]string{"error": "invalid_grant"})
			return
		}
		s.TokenCalls++
		s.token = fmt.Sprintf("at-%d", s.TokenCalls)
		jsonOut(w, 200, map[string]any{"access_token": s.token, "expires_in": 3600})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+s.token || s.token == "" {
		apiErr(w, 401, "authError")
		return
	}

	op := ""
	switch {
	case path == "/drive/v3/about":
		op = "about"
	case path == "/drive/v3/files" && r.Method == http.MethodGet:
		op = "list"
	case path == "/drive/v3/files" && r.Method == http.MethodPost:
		op = "create"
	case strings.HasPrefix(path, "/drive/v3/files/") && r.Method == http.MethodPatch:
		op = "patch"
	case strings.HasPrefix(path, "/drive/v3/files/") && r.Method == http.MethodDelete:
		op = "delete"
	case strings.HasPrefix(path, "/drive/v3/files/") && r.Method == http.MethodGet:
		op = "media"
	case path == "/upload/drive/v3/files":
		op = "session"
	case strings.HasPrefix(path, "/upload/session/"):
		op = "chunk"
	}
	s.Requests[op]++
	if f := s.take(op); f != nil {
		if op == "chunk" && f.partial {
			s.appendChunk(r, true)
		}
		apiErr(w, f.status, reasonFor(f.status))
		return
	}

	switch op {
	case "about":
		var used int64
		for _, f := range s.Files {
			used += int64(len(f.Data))
		}
		jsonOut(w, 200, map[string]any{"storageQuota": map[string]string{"limit": strconv.FormatInt(s.Limit, 10),
			"usage": strconv.FormatInt(used, 10)}, "user": map[string]string{"emailAddress": "dono@example.com"}})
	case "list":
		q := r.URL.Query().Get("q")
		var out []map[string]any
		for _, f := range s.Files {
			if strings.Contains(q, "mimeType='"+folderMime+"'") && f.Mime != folderMime {
				continue
			}
			if m := reName.FindStringSubmatch(q); m != nil && strings.ReplaceAll(m[1], `\'`, `'`) != f.Name {
				continue
			}
			if m := reParent.FindStringSubmatch(q); m != nil && !has(f.Parents, m[1]) {
				continue
			}
			out = append(out, s.fileJSON(f))
		}
		jsonOut(w, 200, map[string]any{"files": out})
	case "create":
		var meta struct {
			Name     string   `json:"name"`
			MimeType string   `json:"mimeType"`
			Parents  []string `json:"parents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&meta)
		f := &File{ID: s.newID(), Name: meta.Name, Mime: meta.MimeType, Parents: meta.Parents}
		s.Files[f.ID] = f
		jsonOut(w, 200, s.fileJSON(f))
	case "patch":
		f := s.Files[strings.TrimPrefix(path, "/drive/v3/files/")]
		if f == nil {
			apiErr(w, 404, "notFound")
			return
		}
		var meta struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&meta)
		if meta.Name != "" {
			f.Name = meta.Name
		}
		if rm := r.URL.Query().Get("removeParents"); rm != "" {
			f.Parents = without(f.Parents, rm)
		}
		if add := r.URL.Query().Get("addParents"); add != "" {
			f.Parents = append(f.Parents, add)
		}
		jsonOut(w, 200, s.fileJSON(f))
	case "delete":
		id := strings.TrimPrefix(path, "/drive/v3/files/")
		if s.Files[id] == nil {
			apiErr(w, 404, "notFound")
			return
		}
		s.deleteTree(id)
		w.WriteHeader(204)
	case "media":
		f := s.Files[strings.TrimPrefix(path, "/drive/v3/files/")]
		if f == nil {
			apiErr(w, 404, "notFound")
			return
		}
		data, status := f.Data, 200
		if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=") {
			parts := strings.SplitN(strings.TrimPrefix(rg, "bytes="), "-", 2)
			a, _ := strconv.Atoi(parts[0])
			b := len(f.Data) - 1
			if len(parts) == 2 && parts[1] != "" {
				b, _ = strconv.Atoi(parts[1])
			}
			if b >= len(f.Data) {
				b = len(f.Data) - 1
			}
			data, status = f.Data[a:b+1], 206
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, len(f.Data)))
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(status)
		_, _ = w.Write(data)
	case "session":
		var meta struct {
			Name          string            `json:"name"`
			MimeType      string            `json:"mimeType"`
			Parents       []string          `json:"parents"`
			AppProperties map[string]string `json:"appProperties"`
		}
		_ = json.NewDecoder(r.Body).Decode(&meta)
		size, _ := strconv.ParseInt(r.Header.Get("X-Upload-Content-Length"), 10, 64)
		sid := s.newID()
		s.sessions[sid] = &session{meta: File{Name: meta.Name, Mime: meta.MimeType, Parents: meta.Parents, AppProps: meta.AppProperties}, size: size}
		w.Header().Set("Location", s.URL+"/upload/session/"+sid)
		w.WriteHeader(200)
	case "chunk":
		sess, done := s.appendChunk(r, false)
		if sess == nil {
			apiErr(w, 404, "notFound")
			return
		}
		if done != nil {
			jsonOut(w, 200, s.fileJSON(done))
			return
		}
		if len(sess.data) > 0 {
			w.Header().Set("Range", fmt.Sprintf("bytes=0-%d", len(sess.data)-1))
		}
		w.WriteHeader(308)
	default:
		http.NotFound(w, r)
	}
}

// appendChunk stores the PUT body at its offset; returns the finished file when complete.
func (s *Server) appendChunk(r *http.Request, half bool) (*session, *File) {
	sid := strings.TrimPrefix(r.URL.Path, "/upload/session/")
	sess := s.sessions[sid]
	if sess == nil {
		return nil, nil
	}
	body, _ := io.ReadAll(r.Body)
	cr := r.Header.Get("Content-Range")
	if !strings.HasPrefix(cr, "bytes */") {
		var a, b, total int64
		fmt.Sscanf(cr, "bytes %d-%d/%d", &a, &b, &total)
		if half {
			body = body[:len(body)/2]
		}
		if a == int64(len(sess.data)) {
			sess.data = append(sess.data, body...)
		}
	}
	if int64(len(sess.data)) == sess.size && !half {
		f := sess.meta
		f.ID = s.newID()
		f.Data = sess.data
		s.Files[f.ID] = &f
		delete(s.sessions, sid)
		return sess, &f
	}
	return sess, nil
}

func (s *Server) deleteTree(id string) {
	delete(s.Files, id)
	for cid, f := range s.Files {
		if has(f.Parents, id) {
			s.deleteTree(cid)
		}
	}
}

// Snapshot helpers for assertions.

func (s *Server) FileCount(mime string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, f := range s.Files {
		if (mime == folderMime) == (f.Mime == folderMime) {
			n++
		}
	}
	return n
}

func (s *Server) Get(id string) *File {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f := s.Files[id]; f != nil {
		cp := *f
		return &cp
	}
	return nil
}

func (s *Server) ByName(name string) *File {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.Files {
		if f.Name == name {
			cp := *f
			return &cp
		}
	}
	return nil
}

func (s *Server) Count(op string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Requests[op]
}

const FolderMime = folderMime

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func without(list []string, v string) []string {
	out := list[:0:0]
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
