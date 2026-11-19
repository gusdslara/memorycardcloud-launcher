package catalog

import (
	"bytes"
	"os"
	"testing"
)

// The mirror stays under the total budget: current versions first (most downloaded first),
// previous versions only with leftover room; whatever does not fit becomes garbage.
func TestMirrorBudgetKeepsCurrentMostDownloaded(t *testing.T) {
	dir, err := os.MkdirTemp("", "mirror-budget-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir) // best effort (Windows)

	s := &Service{
		cfg: Config{
			MirrorPlatform:   map[string]bool{"windows": true, "linux": true},
			MaxMirrorBytes:   100,
			MirrorTotalBytes: 100,
		},
		blobs: blobStore{dir: dir},
		state: &State{
			Resolved: map[string]*Resolved{},
			Mirrors:  map[string]*MirrorState{},
			Images:   map[string]*ImageState{},
		},
	}
	put := func(data string) string {
		sha, _, err := s.blobs.put(bytes.NewReader([]byte(data)), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		return sha
	}
	add := func(id, platform, url, prev string, size, downloads int64, stored bool) string {
		s.state.Resolved[resolvedKey(id, platform)] = &Resolved{OfficialURL: url, PreviousURL: prev, Size: size}
		m := &MirrorState{URL: url, Size: size, Downloads: downloads}
		if stored {
			m.SHA256 = put(url)
		}
		s.state.Mirrors[url] = m
		return m.SHA256
	}

	popular := add("a", "windows", "u/a2", "u/a1", 60, 50, true)
	old := put("u/a1")
	s.state.Mirrors["u/a1"] = &MirrorState{URL: "u/a1", SHA256: old, Size: 60}
	big := add("b", "windows", "u/b", "", 60, 1, true) // would pass the 100-byte budget
	small := add("c", "linux", "u/c", "", 30, 0, true)
	add("d", "macos", "u/d", "", 10, 99, false)    // platform not mirrored
	add("e", "windows", "u/e", "", 500, 99, false) // over the per-file cap

	s.mu.Lock()
	sel := s.mirrorSelectionLocked()
	s.mu.Unlock()
	if !sel["u/a2"] || !sel["u/c"] || sel["u/b"] || sel["u/a1"] || sel["u/d"] || sel["u/e"] {
		t.Fatalf("selection = %v", sel)
	}

	keep := s.referencedBlobs()
	if !keep[popular] || !keep[small] || keep[big] || keep[old] {
		t.Fatalf("keep = %v", keep)
	}
	if m := s.state.Mirrors["u/a1"]; m == nil || m.SHA256 != "" {
		t.Fatalf("previous version over the budget should lose its stored copy: %+v", m)
	}
	if m := s.state.Mirrors["u/b"]; m == nil || m.SHA256 != "" || m.Size != 60 {
		t.Fatalf("over-budget file should keep its entry without the stored copy: %+v", m)
	}
	if _, err := s.blobs.gc(keep); err != nil {
		t.Fatal(err)
	}
	if s.blobs.has(old) || s.blobs.has(big) || !s.blobs.has(popular) || !s.blobs.has(small) {
		t.Fatal("gc should drop the previous version and the over-budget file only")
	}
}
