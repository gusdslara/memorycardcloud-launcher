package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// blobStore keeps files content-addressed by SHA-256, so the same binary or
// image is stored exactly once no matter how many items reference it.
type blobStore struct{ dir string }

func (b blobStore) path(sha string) string {
	if len(sha) < 2 {
		return filepath.Join(b.dir, "invalid")
	}
	return filepath.Join(b.dir, sha[:2], sha)
}

func (b blobStore) has(sha string) bool {
	if sha == "" {
		return false
	}
	st, err := os.Stat(b.path(sha))
	return err == nil && st.Mode().IsRegular()
}

var errTooLarge = errors.New("arquivo maior que o limite do mirror")

// put streams r into the store while hashing it; returns sha256 and size.
func (b blobStore) put(r io.Reader, maxBytes int64) (string, int64, error) {
	if err := os.MkdirAll(b.dir, 0o755); err != nil {
		return "", 0, err
	}
	tmp, err := os.CreateTemp(b.dir, "incoming-*")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	h := sha256.New()
	limited := io.LimitReader(r, maxBytes+1)
	n, err := io.Copy(io.MultiWriter(tmp, h), limited)
	closeErr := tmp.Close()
	if err != nil {
		return "", 0, err
	}
	if closeErr != nil {
		return "", 0, closeErr
	}
	if n > maxBytes {
		return "", 0, errTooLarge
	}
	sha := hex.EncodeToString(h.Sum(nil))
	if b.has(sha) {
		return sha, n, nil // dedupe: identical content already stored
	}
	if err := os.MkdirAll(filepath.Dir(b.path(sha)), 0o755); err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), b.path(sha)); err != nil {
		if b.has(sha) {
			// a concurrent download of identical bytes won the rename (Windows refuses to replace it)
			return sha, n, nil
		}
		return "", 0, err
	}
	return sha, n, nil
}

// gc deletes blobs that are no longer referenced. Returns freed bytes.
func (b blobStore) gc(keep map[string]bool) (int64, error) {
	var freed int64
	err := filepath.WalkDir(b.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, "incoming-") {
			if info, e := d.Info(); e == nil {
				freed += info.Size()
			}
			return os.Remove(p) // leftovers of interrupted downloads
		}
		if len(name) == 64 && !keep[name] {
			if info, e := d.Info(); e == nil {
				freed += info.Size()
			}
			return os.Remove(p)
		}
		return nil
	})
	return freed, err
}

// download fetches url into the blob store.
func (s *Service) downloadBlob(ctx context.Context, u string, maxBytes int64, extra http.Header) (sha string, size int64, contentType string, etag string, notModified bool, err error) {
	req, err := s.newRequest(ctx, http.MethodGet, u)
	if err != nil {
		return
	}
	for k, vs := range extra {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		notModified = true
		return
	}
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		err = &httpStatusError{URL: u, StatusCode: resp.StatusCode, Status: resp.Status, RateLimit: isRateLimited(resp)}
		return
	}
	if resp.ContentLength > maxBytes {
		err = errTooLarge
		return
	}
	contentType = resp.Header.Get("Content-Type")
	etag = resp.Header.Get("ETag")
	sha, size, err = s.blobs.put(resp.Body, maxBytes)
	return
}
