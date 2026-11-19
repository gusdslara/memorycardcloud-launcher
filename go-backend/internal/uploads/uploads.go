// Package uploads receives big files (games, app builds) from the admin page in
// chunks, so a multi-GB upload never sits in memory and can resume after a drop.
//
//	POST /api/admin/uploads            {"file_name": "...", "size": 123}  → {"id": "...", "received": 0}
//	PUT  /api/admin/uploads/:id        raw bytes, header Upload-Offset: <bytes already sent>
//	GET  /api/admin/uploads/:id        → {"received": n, "size": total}  (resume)
//
// When received == size the file is complete and other handlers take it with Take().
package uploads

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

type Upload struct {
	ID       string    `json:"id"`
	FileName string    `json:"file_name"`
	Size     int64     `json:"size"`
	Received int64     `json:"received"`
	Owner    uint      `json:"-"`
	Started  time.Time `json:"started"`
}

type Manager struct {
	dir string
	mu  sync.Mutex
}

var (
	ErrNotFound    = errors.New("upload não encontrado")
	ErrOffset      = errors.New("offset diferente do que o servidor recebeu")
	ErrTooBig      = errors.New("o pedaço passa do tamanho anunciado")
	ErrIncomplete  = errors.New("upload incompleto")
	idRe           = regexp.MustCompile(`^[a-f0-9]{32}$`)
	MaxFileSize    = int64(64) << 30 // 64 GB
	staleAfter     = 48 * time.Hour
	defaultManager *Manager
	defaultMu      sync.Mutex
)

// Default uses $DATA_DIR/upload-tmp (re-created if DATA_DIR changes, e.g. in tests).
func Default() *Manager {
	base := os.Getenv("DATA_DIR")
	if base == "" {
		base = "./data"
	}
	dir := filepath.Join(base, "upload-tmp")
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultManager == nil || defaultManager.dir != dir {
		defaultManager = New(dir)
	}
	return defaultManager
}

func New(dir string) *Manager {
	_ = os.MkdirAll(dir, 0o755)
	m := &Manager{dir: dir}
	m.cleanup()
	return m
}

func (m *Manager) metaPath(id string) string { return filepath.Join(m.dir, id+".json") }
func (m *Manager) dataPath(id string) string { return filepath.Join(m.dir, id+".part") }

func (m *Manager) Start(owner uint, fileName string, size int64) (*Upload, error) {
	if size <= 0 || size > MaxFileSize {
		return nil, fmt.Errorf("tamanho inválido (máximo %d GB)", MaxFileSize>>30)
	}
	fileName = filepath.Base(filepath.Clean("/" + fileName))
	if fileName == "/" || fileName == "." || fileName == "" {
		return nil, errors.New("nome de arquivo inválido")
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	u := &Upload{ID: hex.EncodeToString(b), FileName: fileName, Size: size, Owner: owner, Started: time.Now()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := os.WriteFile(m.dataPath(u.ID), nil, 0o644); err != nil {
		return nil, err
	}
	return u, m.save(u)
}

func (m *Manager) save(u *Upload) error {
	b, _ := json.Marshal(struct {
		*Upload
		Owner uint `json:"owner"`
	}{u, u.Owner})
	return os.WriteFile(m.metaPath(u.ID), b, 0o644)
}

func (m *Manager) load(id string) (*Upload, error) {
	if !idRe.MatchString(id) {
		return nil, ErrNotFound
	}
	b, err := os.ReadFile(m.metaPath(id))
	if err != nil {
		return nil, ErrNotFound
	}
	var raw struct {
		Upload
		Owner uint `json:"owner"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, ErrNotFound
	}
	u := raw.Upload
	u.Owner = raw.Owner
	if st, err := os.Stat(m.dataPath(id)); err == nil {
		u.Received = st.Size()
	}
	return &u, nil
}

// Get returns the upload state (owner must match).
func (m *Manager) Get(owner uint, id string) (*Upload, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, err := m.load(id)
	if err != nil || u.Owner != owner {
		return nil, ErrNotFound
	}
	return u, nil
}

// Append writes one chunk at offset. Repeating the last chunk is harmless.
func (m *Manager) Append(owner uint, id string, offset int64, chunk []byte) (*Upload, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, err := m.load(id)
	if err != nil || u.Owner != owner {
		return nil, ErrNotFound
	}
	if offset+int64(len(chunk)) <= u.Received && offset <= u.Received {
		return u, nil // already have it (retry after a timeout)
	}
	if offset != u.Received {
		return u, ErrOffset
	}
	if offset+int64(len(chunk)) > u.Size {
		return u, ErrTooBig
	}
	f, err := os.OpenFile(m.dataPath(id), os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	n, err := f.Write(chunk)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	u.Received += int64(n)
	return u, err
}

// Take hands a complete upload over to the caller: returns the temp path and the
// original file name. The caller must move/delete the file, then call Done.
func (m *Manager) Take(owner uint, id string) (string, *Upload, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, err := m.load(id)
	if err != nil || u.Owner != owner {
		return "", nil, ErrNotFound
	}
	if u.Received != u.Size {
		return "", u, ErrIncomplete
	}
	return m.dataPath(id), u, nil
}

// Done removes the upload's temp files.
func (m *Manager) Done(id string) {
	if !idRe.MatchString(id) {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	os.Remove(m.dataPath(id))
	os.Remove(m.metaPath(id))
}

func (m *Manager) cleanup() {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > staleAfter {
			os.Remove(filepath.Join(m.dir, e.Name()))
		}
	}
}
