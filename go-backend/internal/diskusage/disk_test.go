package diskusage

import (
	"path/filepath"
	"testing"
)

func TestOfExistingAndMissingPath(t *testing.T) {
	dir := t.TempDir()
	u, err := Of(dir)
	if err != nil || u.Total == 0 || u.Used > u.Total || u.Free > u.Total {
		t.Fatalf("usage of %s: %+v %v", dir, u, err)
	}
	// a folder that does not exist yet (cache before the first copy) uses its parent's disk
	m, err := Of(filepath.Join(dir, "roms-cache", "PS2"))
	if err != nil || m.Total != u.Total {
		t.Fatalf("missing path: %+v %v", m, err)
	}
}
