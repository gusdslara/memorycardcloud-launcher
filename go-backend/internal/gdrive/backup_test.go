package gdrive_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"go-backend/internal/gdrive"
	"go-backend/internal/gdrive/gdrivetest"
	"go-backend/models"
)

func newSvc() *gdrive.DriveService {
	return gdrive.NewDriveService(models.GoogleDriveConfig{OAuthRefreshToken: "rt-owner"})
}

func tempFile(t *testing.T, size int) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	_, _ = rand.Read(data)
	p := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

func TestResumableUploadSurvivesFaultsAndTokenExpiry(t *testing.T) {
	fake := gdrivetest.Start(t)
	svc := newSvc()
	ctx := context.Background()

	root, err := svc.EnsureFolder(ctx, "MemoryCard Backups", "")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := svc.EnsureFolder(ctx, "MemoryCard Backups", "")
	if again != root {
		t.Fatalf("EnsureFolder created a duplicate: %s vs %s", again, root)
	}

	path, data := tempFile(t, 5*256<<10+123) // 6 chunks of 256 KiB
	fake.Fail("chunk", 503, 1, true)         // a chunk dies half way (Drive keeps half)
	fake.Fail("session", 429, 1, false)      // rate limited when opening the session
	fake.ExpireToken()                       // access token revoked → refresh with the stored refresh token

	var sessions []string
	obj, err := svc.UploadResumable(ctx, path, gdrive.UploadMeta{Name: "save.zip", Parent: root,
		AppProperties: map[string]string{"mc_sha256": "x"}}, "", func(u string) { sessions = append(sessions, u) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := fake.Get(obj.ID)
	if got == nil || !bytes.Equal(got.Data, data) {
		t.Fatalf("uploaded bytes differ (%d vs %d)", len(got.Data), len(data))
	}
	if got.Parents[0] != root || got.AppProps["mc_sha256"] != "x" {
		t.Fatalf("metadata lost: %+v", got)
	}
	if fake.TokenCalls < 2 {
		t.Fatalf("token was not refreshed after 401 (calls=%d)", fake.TokenCalls)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected one persisted session, got %v", sessions)
	}

	// Range download
	resp, err := svc.OpenMedia(ctx, obj.ID, "bytes=10-19")
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || !bytes.Equal(part, data[10:20]) {
		t.Fatalf("range download: %d %x", resp.StatusCode, part)
	}

	// Move, delete (missing file = ok)
	other, _ := svc.CreateFolder(ctx, "shared", root)
	if err := svc.MoveFile(ctx, obj.ID, root, other, "abc.zip"); err != nil {
		t.Fatal(err)
	}
	if f := fake.Get(obj.ID); f.Parents[0] != other || f.Name != "abc.zip" {
		t.Fatalf("move failed: %+v", f)
	}
	if err := svc.DeleteFile(ctx, obj.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteFile(ctx, obj.ID); err != nil {
		t.Fatalf("deleting a missing file should be ok: %v", err)
	}
}

func TestResumableUploadContinuesSavedSession(t *testing.T) {
	fake := gdrivetest.Start(t)
	svc := newSvc()
	ctx := context.Background()
	path, data := tempFile(t, 3*256<<10)

	// First run: the process "dies" (context cancelled) after the session started.
	var saved string
	cctx, cancel := context.WithCancel(ctx)
	_, err := svc.UploadResumable(cctx, path, gdrive.UploadMeta{Name: "big.iso"}, "", func(u string) { saved = u },
		func(n int64) {
			if n >= 256<<10 {
				cancel()
			}
		})
	if err == nil || saved == "" {
		t.Fatalf("expected an interrupted upload with a saved session (err=%v)", err)
	}
	before := fake.Count("session")

	// Second run resumes the same session (no new session, bytes already sent are not resent).
	obj, err := svc.UploadResumable(ctx, path, gdrive.UploadMeta{Name: "big.iso"}, saved, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fake.Count("session") != before {
		t.Fatal("a new session was opened instead of resuming")
	}
	if !bytes.Equal(fake.Get(obj.ID).Data, data) {
		t.Fatal("resumed upload is corrupt")
	}
}

func TestPermanentErrorsAreClassified(t *testing.T) {
	fake := gdrivetest.Start(t)
	svc := newSvc()
	ctx := context.Background()

	fake.Fail("create", 403, 1, false) // 403 rate limit → retried
	if _, err := svc.CreateFolder(ctx, "a", ""); err != nil {
		t.Fatalf("rate-limit 403 must be retried: %v", err)
	}
	fake.Fail("media", 500, 100, false)
	gdrive.MaxRetries = 3
	defer func() { gdrive.MaxRetries = 8 }()
	if _, err := svc.OpenMedia(ctx, "nope", ""); err == nil {
		t.Fatal("expected an error after the retries")
	}
	fake.Fail("media", 0, 0, false)
	if _, err := svc.OpenMedia(ctx, "nope", ""); !errors.Is(err, gdrive.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
