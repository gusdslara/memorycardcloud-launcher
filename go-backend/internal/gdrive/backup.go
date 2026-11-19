package gdrive

// Write side of the owner's Google Drive, used by the users' cloud backups (internal/backupstore).
//
// Scope: drive.file — the server only sees and changes what it created itself (the
// "MemoryCard Backups" tree). The ROM library keeps using drive.readonly.
//
// Limits respected here (developers.google.com/workspace/drive/api/guides/limits):
//   - quota units per minute per user/project → client-side rate limiter (RequestsPerSecond);
//   - 403 "User rate limit exceeded" / 429 / 5xx → exponential backoff with jitter, max 64 s;
//   - 401 → the cached access token is dropped and refreshed with the stored refresh token;
//   - big files → resumable upload in ChunkSize pieces (multiple of 256 KiB), resumed from the
//     offset the Drive confirms, and the session URI is kept so a restart continues it;
//   - 750 GB / 24 h of uploads → enforced by the caller (backupstore ledger); ErrUploadLimit
//     tells it the Drive refused because of that limit.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DriveFileScope lets the server create files/folders and manage only the ones it created.
const DriveFileScope = "https://www.googleapis.com/auth/drive.file"

var (
	DriveUploadAPI    = "https://www.googleapis.com/upload/drive/v3"
	ChunkSize         = int64(32 << 20) // 32 MiB, multiple of 256 KiB
	MaxRetries        = 8
	MaxBackoff        = 64 * time.Second
	BaseBackoff       = time.Second
	RequestsPerSecond = 8.0

	ErrNotFound     = errors.New("arquivo não encontrado no Google Drive")
	ErrNoWriteScope = errors.New("o Google Drive foi conectado sem permissão de gravação: reconecte no painel admin")
	ErrUploadLimit  = errors.New("limite diário de upload do Google Drive atingido (750 GB/24 h)")
	ErrStorageFull  = errors.New("o armazenamento do Google Drive está cheio")
	ErrSessionGone  = errors.New("sessão de upload expirou")
	sleep           = sleepCtx // swapped in tests
	limiterMu       sync.Mutex
	limiterNext     time.Time
)

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// throttle spaces requests (shared by every DriveService: the quota is per account/project).
func throttle(ctx context.Context) error {
	if RequestsPerSecond <= 0 {
		return nil
	}
	gap := time.Duration(float64(time.Second) / RequestsPerSecond)
	limiterMu.Lock()
	now := time.Now()
	if limiterNext.Before(now) {
		limiterNext = now
	}
	wait := limiterNext.Sub(now)
	limiterNext = limiterNext.Add(gap)
	limiterMu.Unlock()
	if wait > 0 {
		return sleep(ctx, wait)
	}
	return nil
}

func backoff(attempt int) time.Duration {
	d := BaseBackoff << uint(attempt)
	if d > MaxBackoff || d <= 0 {
		d = MaxBackoff
	}
	jitter := BaseBackoff
	if jitter > time.Second {
		jitter = time.Second
	}
	return d + time.Duration(rand.Int63n(int64(jitter)+1))
}

// InvalidateToken forgets the cached access token (next call refreshes it).
func (s *DriveService) InvalidateToken() {
	s.tokenLock.Lock()
	s.cachedToken = ""
	s.tokenExpiry = time.Time{}
	s.tokenLock.Unlock()
}

type apiError struct {
	Status  int
	Reason  string
	Message string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("google drive %d %s: %s", e.Status, e.Reason, e.Message)
}

func parseAPIError(resp *http.Response) *apiError {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	e := &apiError{Status: resp.StatusCode}
	var body struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil {
		e.Message = body.Error.Message
		if len(body.Error.Errors) > 0 {
			e.Reason = body.Error.Errors[0].Reason
		}
	}
	if e.Message == "" {
		e.Message = strings.TrimSpace(string(raw))
	}
	return e
}

func (e *apiError) retryable() bool {
	switch {
	case e.Status == 429, e.Status >= 500:
		return true
	case e.Status == 403:
		r := strings.ToLower(e.Reason + " " + e.Message)
		return strings.Contains(r, "ratelimit") || strings.Contains(r, "rate limit")
	}
	return false
}

// classify turns a final API error into the package errors callers handle.
func (e *apiError) classify() error {
	r := strings.ToLower(e.Reason + " " + e.Message)
	switch {
	case e.Status == 404:
		return ErrNotFound
	case e.Status == 403 && (strings.Contains(r, "insufficient") || strings.Contains(r, "scope")):
		return ErrNoWriteScope
	case e.Status == 403 && (strings.Contains(r, "uploadlimit") || strings.Contains(r, "upload limit") || strings.Contains(r, "daily")):
		return ErrUploadLimit
	case e.Status == 403 && strings.Contains(r, "storagequota"):
		return ErrStorageFull
	}
	return e
}

// call does one API request with throttling, token refresh and backoff.
// body is a factory so every retry sends a fresh reader.
func (s *DriveService) call(ctx context.Context, method, rawURL string, body func() io.Reader, hdr http.Header, okStatus ...int) (*http.Response, error) {
	refreshed := false
	var last error
	for attempt := 0; attempt < MaxRetries; attempt++ {
		if err := throttle(ctx); err != nil {
			return nil, err
		}
		token, err := s.GetAccessToken()
		if err != nil {
			return nil, err
		}
		var rd io.Reader
		if body != nil {
			rd = body()
		}
		req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
		if err != nil {
			return nil, err
		}
		for k, v := range hdr {
			req.Header[k] = v
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := noTimeout.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			last = err
			if err := sleep(ctx, backoff(attempt)); err != nil {
				return nil, err
			}
			continue
		}
		if resp.StatusCode < 300 || contains(okStatus, resp.StatusCode) {
			return resp, nil
		}
		apiErr := parseAPIError(resp)
		resp.Body.Close()
		if resp.StatusCode == 401 && !refreshed {
			refreshed = true
			s.InvalidateToken()
			attempt-- // the refresh does not count as a retry
			continue
		}
		if !apiErr.retryable() {
			return nil, apiErr.classify()
		}
		last = apiErr
		if err := sleep(ctx, backoff(attempt)); err != nil {
			return nil, err
		}
	}
	if ae, ok := last.(*apiError); ok {
		return nil, ae.classify()
	}
	return nil, fmt.Errorf("google drive indisponível depois de %d tentativas: %w", MaxRetries, last)
}

func contains(list []int, v int) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func jsonBody(v any) func() io.Reader {
	b, _ := json.Marshal(v)
	return func() io.Reader { return bytes.NewReader(b) }
}

var jsonHeader = http.Header{"Content-Type": {"application/json; charset=UTF-8"}}

// DriveObject is a file the server stored in the Drive.
type DriveObject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size string `json:"size"`
	MD5  string `json:"md5Checksum"`
}

// CreateFolder creates a folder under parent ("" = My Drive root).
func (s *DriveService) CreateFolder(ctx context.Context, name, parent string) (string, error) {
	meta := map[string]any{"name": name, "mimeType": folderMime}
	if parent != "" {
		meta["parents"] = []string{parent}
	}
	resp, err := s.call(ctx, http.MethodPost, DriveAPI+"/files?fields=id&supportsAllDrives=true", jsonBody(meta), jsonHeader)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out DriveObject
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil || out.ID == "" {
		return "", fmt.Errorf("resposta inválida ao criar pasta %q", name)
	}
	return out.ID, nil
}

// FindFolder looks for a folder created by the server (drive.file only sees those).
func (s *DriveService) FindFolder(ctx context.Context, name, parent string) (string, error) {
	q := fmt.Sprintf("mimeType='%s' and trashed=false and name='%s'", folderMime, escapeQ(name))
	if parent != "" {
		q += fmt.Sprintf(" and '%s' in parents", escapeQ(parent))
	}
	v := url.Values{"q": {q}, "fields": {"files(id)"}, "pageSize": {"10"}, "supportsAllDrives": {"true"}, "includeItemsFromAllDrives": {"true"}}
	resp, err := s.call(ctx, http.MethodGet, DriveAPI+"/files?"+v.Encode(), nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		Files []DriveObject `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Files) == 0 {
		return "", nil
	}
	return out.Files[0].ID, nil
}

// EnsureFolder finds or creates name under parent.
func (s *DriveService) EnsureFolder(ctx context.Context, name, parent string) (string, error) {
	if id, err := s.FindFolder(ctx, name, parent); err != nil || id != "" {
		return id, err
	}
	return s.CreateFolder(ctx, name, parent)
}

// DeleteFile removes a file permanently (trash still counts in the quota). Missing = success.
func (s *DriveService) DeleteFile(ctx context.Context, id string) error {
	resp, err := s.call(ctx, http.MethodDelete, DriveAPI+"/files/"+url.PathEscape(id)+"?supportsAllDrives=true", nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// MoveFile moves a file from one folder to another (no bytes are copied).
func (s *DriveService) MoveFile(ctx context.Context, id, from, to, newName string) error {
	v := url.Values{"addParents": {to}, "supportsAllDrives": {"true"}, "fields": {"id"}}
	if from != "" {
		v.Set("removeParents", from)
	}
	meta := map[string]any{}
	if newName != "" {
		meta["name"] = newName
	}
	resp, err := s.call(ctx, http.MethodPatch, DriveAPI+"/files/"+url.PathEscape(id)+"?"+v.Encode(), jsonBody(meta), jsonHeader)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// OpenMedia streams a file (rangeHeader like "bytes=0-99" or ""). Caller closes the body.
func (s *DriveService) OpenMedia(ctx context.Context, id, rangeHeader string) (*http.Response, error) {
	hdr := http.Header{}
	if rangeHeader != "" {
		hdr.Set("Range", rangeHeader)
	}
	return s.call(ctx, http.MethodGet, DriveAPI+"/files/"+url.PathEscape(id)+"?alt=media&supportsAllDrives=true", nil, hdr, http.StatusPartialContent)
}

// UploadMeta describes the file being uploaded.
type UploadMeta struct {
	Name          string
	Parent        string
	MimeType      string
	AppProperties map[string]string
}

// UploadResumable sends the local file at path with the resumable protocol. sessionURI resumes a
// previous session ("" starts one); saveSession is called with every new session URI so the
// caller can persist it. progress (optional) receives the bytes confirmed by the Drive.
func (s *DriveService) UploadResumable(ctx context.Context, path string, meta UploadMeta, sessionURI string,
	saveSession func(string), progress func(int64)) (DriveObject, error) {
	f, err := os.Open(path)
	if err != nil {
		return DriveObject{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return DriveObject{}, err
	}
	size := st.Size()
	if meta.MimeType == "" {
		meta.MimeType = "application/octet-stream"
	}

	for restart := 0; restart < 3; restart++ {
		if sessionURI == "" {
			sessionURI, err = s.startSession(ctx, meta, size)
			if err != nil {
				return DriveObject{}, err
			}
			if saveSession != nil {
				saveSession(sessionURI)
			}
		}
		obj, err := s.sendChunks(ctx, f, size, sessionURI, progress)
		if errors.Is(err, ErrSessionGone) {
			sessionURI = ""
			if saveSession != nil {
				saveSession("")
			}
			continue
		}
		return obj, err
	}
	return DriveObject{}, ErrSessionGone
}

func (s *DriveService) startSession(ctx context.Context, meta UploadMeta, size int64) (string, error) {
	m := map[string]any{"name": meta.Name, "mimeType": meta.MimeType}
	if meta.Parent != "" {
		m["parents"] = []string{meta.Parent}
	}
	if len(meta.AppProperties) > 0 {
		m["appProperties"] = meta.AppProperties
	}
	hdr := http.Header{
		"Content-Type":            {"application/json; charset=UTF-8"},
		"X-Upload-Content-Type":   {meta.MimeType},
		"X-Upload-Content-Length": {strconv.FormatInt(size, 10)},
	}
	resp, err := s.call(ctx, http.MethodPost, DriveUploadAPI+"/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum", jsonBody(m), hdr)
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	if loc == "" {
		return "", errors.New("o Google Drive não devolveu a sessão de upload")
	}
	return loc, nil
}

// queryOffset asks the Drive how many bytes of the session it has (or the final object).
func (s *DriveService) queryOffset(ctx context.Context, sessionURI string, size int64) (int64, *DriveObject, error) {
	hdr := http.Header{"Content-Range": {fmt.Sprintf("bytes */%d", size)}}
	resp, err := s.call(ctx, http.MethodPut, sessionURI, func() io.Reader { return http.NoBody }, hdr, http.StatusPermanentRedirect)
	if errors.Is(err, ErrNotFound) {
		return 0, nil, ErrSessionGone
	}
	if ae := (*apiError)(nil); errors.As(err, &ae) && (ae.Status == 410 || ae.Status == 404) {
		return 0, nil, ErrSessionGone
	}
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusPermanentRedirect {
		return rangeEnd(resp.Header.Get("Range")), nil, nil
	}
	var obj DriveObject
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&obj); err != nil {
		return 0, nil, err
	}
	return size, &obj, nil
}

// rangeEnd parses "bytes=0-1234" → 1235 (bytes received). Empty → 0.
func rangeEnd(h string) int64 {
	i := strings.LastIndex(h, "-")
	if i < 0 {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(h[i+1:]), 10, 64)
	if err != nil {
		return 0
	}
	return n + 1
}

func (s *DriveService) sendChunks(ctx context.Context, f *os.File, size int64, sessionURI string, progress func(int64)) (DriveObject, error) {
	offset, done, err := s.queryOffset(ctx, sessionURI, size)
	if err != nil {
		return DriveObject{}, err
	}
	if done != nil {
		return *done, nil
	}
	stalls := 0
	for {
		if progress != nil {
			progress(offset)
		}
		end := offset + ChunkSize
		if end > size {
			end = size
		}
		n := end - offset
		hdr := http.Header{"Content-Length": {strconv.FormatInt(n, 10)}}
		if size == 0 {
			hdr.Set("Content-Range", "bytes */0")
		} else {
			hdr.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, end-1, size))
		}
		start := offset
		resp, err := s.callChunk(ctx, sessionURI, hdr, func() io.Reader { return io.NewSectionReader(f, start, n) }, n)
		if err != nil {
			if errors.Is(err, ErrSessionGone) || ctx.Err() != nil {
				return DriveObject{}, err
			}
			var ae *apiError
			if errors.As(err, &ae) && !ae.retryable() {
				return DriveObject{}, ae.classify()
			}
			// Interrupted chunk: ask where the Drive stopped and continue from there.
			if stalls++; stalls > MaxRetries {
				return DriveObject{}, err
			}
			if err := sleep(ctx, backoff(stalls)); err != nil {
				return DriveObject{}, err
			}
			offset, done, err = s.queryOffset(ctx, sessionURI, size)
			if err != nil {
				return DriveObject{}, err
			}
			if done != nil {
				return *done, nil
			}
			continue
		}
		stalls = 0
		if resp.StatusCode == http.StatusPermanentRedirect {
			resp.Body.Close()
			offset = rangeEnd(resp.Header.Get("Range"))
			continue
		}
		var obj DriveObject
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&obj)
		resp.Body.Close()
		if err != nil || obj.ID == "" {
			return DriveObject{}, errors.New("resposta inválida ao concluir o upload")
		}
		if progress != nil {
			progress(size)
		}
		return obj, nil
	}
}

// callChunk sends one chunk once (the retry loop is in sendChunks, which re-syncs the offset).
func (s *DriveService) callChunk(ctx context.Context, sessionURI string, hdr http.Header, body func() io.Reader, n int64) (*http.Response, error) {
	if err := throttle(ctx); err != nil {
		return nil, err
	}
	token, err := s.GetAccessToken()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, sessionURI, body())
	if err != nil {
		return nil, err
	}
	req.ContentLength = n
	for k, v := range hdr {
		req.Header[k] = v
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := noTimeout.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 300 || resp.StatusCode == http.StatusPermanentRedirect {
		return resp, nil
	}
	ae := parseAPIError(resp)
	resp.Body.Close()
	switch {
	case ae.Status == 404 || ae.Status == 410:
		return nil, ErrSessionGone
	case ae.Status == 401:
		s.InvalidateToken()
		return nil, &apiError{Status: 503, Message: "token renovado"} // retry after re-sync
	}
	return nil, ae
}
