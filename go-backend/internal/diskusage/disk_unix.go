//go:build !windows

package diskusage

import "syscall"

func statfs(path string) (Usage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return Usage{}, err
	}
	bs := uint64(st.Bsize)
	total := uint64(st.Blocks) * bs
	return Usage{Total: total, Used: total - uint64(st.Bfree)*bs, Free: uint64(st.Bavail) * bs}, nil
}
