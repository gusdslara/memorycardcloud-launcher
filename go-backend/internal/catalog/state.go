package catalog

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// Asset is one downloadable file of an upstream release.
type Asset struct {
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

// SourceState caches the last known release of one feed.
type SourceState struct {
	Key         string    `json:"key"`
	ETag        string    `json:"etag,omitempty"`
	Tag         string    `json:"tag,omitempty"`
	ReleasePage string    `json:"releasePage,omitempty"`
	PublishedAt time.Time `json:"publishedAt,omitempty"`
	Assets      []Asset   `json:"assets,omitempty"`
	CheckedAt   time.Time `json:"checkedAt,omitempty"`
	ChangedAt   time.Time `json:"changedAt,omitempty"`
	NextCheckAt time.Time `json:"nextCheckAt,omitempty"`
	IntervalSec int64     `json:"intervalSec,omitempty"`
	Failures    int       `json:"failures,omitempty"`
	LastError   string    `json:"lastError,omitempty"`
	Requests    int64     `json:"requests,omitempty"`
	NotModified int64     `json:"notModified,omitempty"`
}

// Resolved is what we serve for one item on one platform.
type Resolved struct {
	Version     string    `json:"version,omitempty"`
	AssetName   string    `json:"assetName"`
	Size        int64     `json:"size,omitempty"`
	OfficialURL string    `json:"officialUrl"`
	ReleasePage string    `json:"releasePage,omitempty"`
	PublishedAt time.Time `json:"publishedAt,omitempty"`
	// Previous official URL, kept mirrored for one release cycle.
	PreviousURL string `json:"previousUrl,omitempty"`
}

// MirrorState tracks one mirrored upstream file (keyed by its official URL).
type MirrorState struct {
	URL           string    `json:"url"`
	Name          string    `json:"name"`
	SHA256        string    `json:"sha256,omitempty"`
	Size          int64     `json:"size,omitempty"`
	MirroredAt    time.Time `json:"mirroredAt,omitempty"`
	Failures      int       `json:"failures,omitempty"`
	LastError     string    `json:"lastError,omitempty"`
	NextAttemptAt time.Time `json:"nextAttemptAt,omitempty"`
	Downloads     int64     `json:"downloads,omitempty"`
}

// ImageState tracks one scraped image (keyed by itemID|kind).
type ImageState struct {
	ItemID      string    `json:"itemId"`
	Kind        string    `json:"kind"` // logo | cover
	Source      string    `json:"source,omitempty"`
	SourceURL   string    `json:"sourceUrl,omitempty"`
	SHA256      string    `json:"sha256,omitempty"`
	ContentType string    `json:"contentType,omitempty"`
	ETag        string    `json:"etag,omitempty"`
	FetchedAt   time.Time `json:"fetchedAt,omitempty"`
	NextCheckAt time.Time `json:"nextCheckAt,omitempty"`
	Failures    int       `json:"failures,omitempty"`
	LastError   string    `json:"lastError,omitempty"`
	// Preferred is the best catalog-provided URL (override/curated) last tried; when the catalog
	// changes it, the image is re-discovered right away instead of keeping a worse cached source.
	Preferred string `json:"preferred,omitempty"`
	// CheckedAt is when sources were last tried; Attempts says what each one answered in that check
	// (bounded to maxAttempts, replaced on every check). Shown to the superadmin.
	CheckedAt time.Time      `json:"checkedAt,omitempty"`
	Attempts  []ImageAttempt `json:"attempts,omitempty"`
}

// maxRuns bounds the run history kept in state.json.
const maxRuns = 20

type State struct {
	Sources  map[string]*SourceState `json:"sources"`
	Resolved map[string]*Resolved    `json:"resolved"` // itemID|platform
	Mirrors  map[string]*MirrorState `json:"mirrors"`  // official URL
	Images   map[string]*ImageState  `json:"images"`   // itemID|kind
	// Runs = the last scraper runs, oldest first (survives restarts).
	Runs []RunStats `json:"runs,omitempty"`
}

func newState() *State {
	return &State{
		Sources:  map[string]*SourceState{},
		Resolved: map[string]*Resolved{},
		Mirrors:  map[string]*MirrorState{},
		Images:   map[string]*ImageState{},
	}
}

func loadState(path string) (*State, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return newState(), nil
	}
	if err != nil {
		return nil, err
	}
	st := newState()
	if err := json.Unmarshal(b, st); err != nil {
		// Corrupt state must never take the API down: start over (blobs are kept and re-used by hash).
		return newState(), nil
	}
	if st.Sources == nil {
		st.Sources = map[string]*SourceState{}
	}
	if st.Resolved == nil {
		st.Resolved = map[string]*Resolved{}
	}
	if st.Mirrors == nil {
		st.Mirrors = map[string]*MirrorState{}
	}
	if st.Images == nil {
		st.Images = map[string]*ImageState{}
	}
	return st, nil
}

// saveState writes atomically (tmp file + rename) so a crash never leaves half a file.
func saveState(path string, st *State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func resolvedKey(itemID, platform string) string { return itemID + "|" + platform }
func imageKey(itemID, kind string) string        { return itemID + "|" + kind }
