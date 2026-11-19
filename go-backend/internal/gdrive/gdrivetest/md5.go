package gdrivetest

import (
	"crypto/md5"
	"encoding/hex"
)

func md5hex(b []byte) string {
	h := md5.Sum(b)
	return hex.EncodeToString(h[:])
}
