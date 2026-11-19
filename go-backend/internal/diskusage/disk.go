// Package diskusage reports total/used/free space of the filesystem holding a path.
package diskusage

import (
	"os"
	"path/filepath"
)

type Usage struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"` // available to this process
}

// Of measures the filesystem of path (or of its nearest existing parent).
func Of(path string) (Usage, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Usage{}, err
	}
	p := abs
	for {
		if _, err := os.Stat(p); err == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			break
		}
		p = parent
	}
	u, err := statfs(p)
	u.Path = abs
	return u, err
}
