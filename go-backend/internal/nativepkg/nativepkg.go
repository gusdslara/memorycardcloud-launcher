// Package nativepkg inspects games uploaded by the superadmin (abandonware / native
// builds) and normalizes them into something the app can install with one click.
//
// Desktop (windows, linux, macos): a .zip with the game folder (or a single .exe on
// Windows). We list the executables so the app knows what to launch.
//
// Android accepts what people actually have:
//   - a plain .apk
//   - an .xapk (zip with the APK, manifest.json and Android/obb/<package>/…)
//   - a .zip with an .apk plus the data (Android/obb/…, Android/data/…, loose .obb
//     files, or a folder named after the package), or an .xapk inside the .zip
//
// The output is always: one APK (served alone, so the Android installer can open it)
// and, when there is data, one "data" zip whose paths start at Android/ so the app
// extracts it straight into the shared storage root.
package nativepkg

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Result describes the normalized files written to the destination folder.
type Result struct {
	// Kind: "zip" | "exe" (desktop); "apk" | "apk+data" | "split-apk" (android)
	Kind        string   `json:"kind"`
	MainFile    string   `json:"main_file"` // file name inside dest (what "download" serves)
	Size        int64    `json:"size"`
	SHA256      string   `json:"sha256"`
	Executable  string   `json:"executable,omitempty"`  // best guess, relative to the game folder
	Executables []string `json:"executables,omitempty"` // every candidate, best first
	PackageName string   `json:"package_name,omitempty"`
	VersionName string   `json:"version_name,omitempty"`
	ApkFile     string   `json:"apk_file,omitempty"`
	DataFile    string   `json:"data_file,omitempty"`
	DataSize    int64    `json:"data_size,omitempty"`
	ObbFiles    []string `json:"obb_files,omitempty"` // paths inside the data zip (Android/obb/<pkg>/main.1.pkg.obb)
	Notes       []string `json:"notes,omitempty"`
}

var (
	ErrUnsupported = errors.New("formato não suportado")
	pkgRe          = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$`)
	obbNameRe      = regexp.MustCompile(`(?i)^(main|patch)\.\d+\.([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\.obb$`)
	slugRe         = regexp.MustCompile(`[^a-z0-9]+`)
)

// Slug turns a title into a URL-safe id ("Grand Theft Auto: Vice City" → "grand-theft-auto-vice-city").
func Slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	repl := strings.NewReplacer("á", "a", "à", "a", "ã", "a", "â", "a", "é", "e", "ê", "e", "í", "i", "ó", "o", "ô", "o", "õ", "o", "ú", "u", "ç", "c")
	s = slugRe.ReplaceAllString(repl.Replace(s), "-")
	return strings.Trim(s, "-")
}

// Analyze inspects src (the uploaded file, named origName) for platform and writes the
// normalized files into dest as "<base>.<ext>", "<base>.apk", "<base>-data.zip".
func Analyze(platform, src, origName, dest, base string) (*Result, error) {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(origName))
	switch platform {
	case "windows", "linux", "macos":
		return analyzeDesktop(platform, src, ext, dest, base)
	case "android":
		return analyzeAndroid(src, ext, dest, base)
	default:
		return nil, fmt.Errorf("%w: plataforma %q", ErrUnsupported, platform)
	}
}

// ---------------------------------------------------------------- desktop

var skipExe = regexp.MustCompile(`(?i)(unins\d*|uninstall|setup|install|vcredist|vc_redist|dxsetup|dxwebsetup|directx|crash|report|update|launcher_helper|ue4prereq|dotnet|oalinst|physx)`)

func analyzeDesktop(platform, src, ext, dest, base string) (*Result, error) {
	if platform == "windows" && ext == ".exe" {
		out := base + ".exe"
		size, sum, err := copyHash(src, filepath.Join(dest, out))
		if err != nil {
			return nil, err
		}
		return &Result{Kind: "exe", MainFile: out, Size: size, SHA256: sum, Executable: out, Executables: []string{out}}, nil
	}
	if ext != ".zip" {
		return nil, fmt.Errorf("%w: envie um .zip com a pasta do jogo", ErrUnsupported)
	}
	zr, err := zip.OpenReader(src)
	if err != nil {
		return nil, fmt.Errorf("zip inválido: %w", err)
	}
	names := make([]string, 0, len(zr.File))
	sizes := map[string]int64{}
	for _, f := range zr.File {
		n := path.Clean(strings.ReplaceAll(f.Name, "\\", "/"))
		names = append(names, n)
		sizes[n] = int64(f.UncompressedSize64)
	}
	zr.Close()

	root := commonRoot(names)
	var cands []string
	for _, n := range names {
		rel := strings.TrimPrefix(strings.TrimPrefix(n, root), "/")
		low := strings.ToLower(rel)
		switch platform {
		case "windows":
			if strings.HasSuffix(low, ".exe") && !skipExe.MatchString(path.Base(low)) {
				cands = append(cands, rel)
			}
		case "linux":
			if strings.HasSuffix(low, ".appimage") || strings.HasSuffix(low, ".x86_64") || strings.HasSuffix(low, ".sh") {
				cands = append(cands, rel)
			}
		case "macos":
			if i := strings.Index(low, ".app/"); i > 0 {
				app := rel[:i+4]
				if !contains(cands, app) {
					cands = append(cands, app)
				}
			}
		}
	}
	// Best first: shallowest, then biggest (the game binary is usually the largest exe).
	sort.SliceStable(cands, func(i, j int) bool {
		di, dj := strings.Count(cands[i], "/"), strings.Count(cands[j], "/")
		if di != dj {
			return di < dj
		}
		return sizes[path.Join(root, cands[i])] > sizes[path.Join(root, cands[j])]
	})

	out := base + ".zip"
	size, sum, err := copyHash(src, filepath.Join(dest, out))
	if err != nil {
		return nil, err
	}
	r := &Result{Kind: "zip", MainFile: out, Size: size, SHA256: sum, Executables: cands}
	if len(cands) > 0 {
		r.Executable = cands[0]
	} else {
		r.Notes = append(r.Notes, "Nenhum executável encontrado no zip: informe o executável manualmente.")
	}
	return r, nil
}

// commonRoot returns the single top-level folder shared by every entry ("" if none).
func commonRoot(names []string) string {
	root := ""
	for _, n := range names {
		first := strings.SplitN(n, "/", 2)[0]
		if !strings.Contains(n, "/") {
			return "" // a file at the top level
		}
		if root == "" {
			root = first
		} else if root != first {
			return ""
		}
	}
	return root
}

// ---------------------------------------------------------------- android

type xapkManifest struct {
	PackageName string `json:"package_name"`
	VersionName string `json:"version_name"`
	SplitApks   []struct {
		File string `json:"file"`
		ID   string `json:"id"`
	} `json:"split_apks"`
	Expansions []struct {
		File        string `json:"file"`
		InstallPath string `json:"install_path"`
	} `json:"expansions"`
}

func analyzeAndroid(src, ext, dest, base string) (*Result, error) {
	switch ext {
	case ".apk":
		out := base + ".apk"
		size, sum, err := copyHash(src, filepath.Join(dest, out))
		if err != nil {
			return nil, err
		}
		return &Result{Kind: "apk", MainFile: out, ApkFile: out, Size: size, SHA256: sum}, nil
	case ".xapk", ".zip", ".apks":
	default:
		return nil, fmt.Errorf("%w: envie .apk, .xapk ou .zip (apk + dados)", ErrUnsupported)
	}

	zr, err := zip.OpenReader(src)
	if err != nil {
		return nil, fmt.Errorf("arquivo inválido: %w", err)
	}
	defer zr.Close()

	// An .xapk inside a .zip: unpack it and analyze that instead.
	var apks, nested []*zip.File
	var manifest *xapkManifest
	for _, f := range zr.File {
		low := strings.ToLower(f.Name)
		switch {
		case f.FileInfo().IsDir():
		case strings.HasSuffix(low, ".apk"):
			apks = append(apks, f)
		case strings.HasSuffix(low, ".xapk") || strings.HasSuffix(low, ".apks"):
			nested = append(nested, f)
		case path.Base(low) == "manifest.json" && !strings.Contains(strings.Trim(low, "/"), "/"):
			var m xapkManifest
			if rc, err := f.Open(); err == nil {
				if json.NewDecoder(rc).Decode(&m) == nil && m.PackageName != "" {
					manifest = &m
				}
				rc.Close()
			}
		}
	}
	if len(apks) == 0 && len(nested) == 1 {
		tmp, err := os.CreateTemp(dest, "nested-*"+path.Ext(nested[0].Name))
		if err != nil {
			return nil, err
		}
		tmpName := tmp.Name()
		rc, err := nested[0].Open()
		if err == nil {
			_, err = io.Copy(tmp, rc)
			rc.Close()
		}
		tmp.Close()
		defer os.Remove(tmpName)
		if err != nil {
			return nil, err
		}
		r, err := analyzeAndroid(tmpName, strings.ToLower(path.Ext(nested[0].Name)), dest, base)
		if r != nil {
			r.Notes = append(r.Notes, "Usamos o "+path.Base(nested[0].Name)+" que estava dentro do zip.")
		}
		return r, err
	}
	if len(apks) == 0 {
		return nil, fmt.Errorf("%w: nenhum .apk encontrado", ErrUnsupported)
	}

	r := &Result{}
	if manifest != nil {
		r.PackageName, r.VersionName = manifest.PackageName, manifest.VersionName
	}

	// Data: every non-APK entry that belongs in shared storage, mapped to Android/...
	type dataEntry struct {
		f    *zip.File
		path string
	}
	var data []dataEntry
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := strings.ReplaceAll(f.Name, "\\", "/")
		low := strings.ToLower(name)
		if strings.HasSuffix(low, ".apk") || strings.HasSuffix(low, ".xapk") || path.Base(low) == "manifest.json" || path.Base(low) == "icon.png" {
			continue
		}
		target := androidDataPath(name, r.PackageName)
		if target == "" {
			continue
		}
		if r.PackageName == "" {
			r.PackageName = pkgFromDataPath(target)
		}
		data = append(data, dataEntry{f, target})
	}

	// APK(s)
	if len(apks) > 1 {
		// base.apk + split_config.*.apk (App Bundle). The Android installer can't take
		// these from a browser download; keep them together for an installer session.
		r.Kind = "split-apk"
		out := base + "-splits.apks"
		if err := writeZip(filepath.Join(dest, out), func(w *zip.Writer) error {
			for _, f := range apks {
				if err := copyEntry(w, f, path.Base(f.Name), zip.Store); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
		r.ApkFile = out
		r.Notes = append(r.Notes, fmt.Sprintf("APK dividido em %d partes (App Bundle): o app instala pelo instalador de sessões do Android.", len(apks)))
	} else {
		out := base + ".apk"
		rc, err := apks[0].Open()
		if err != nil {
			return nil, err
		}
		_, _, err = writeHash(rc, filepath.Join(dest, out))
		rc.Close()
		if err != nil {
			return nil, err
		}
		r.ApkFile = out
		r.Kind = "apk"
	}

	if len(data) > 0 {
		if r.Kind == "apk" {
			r.Kind = "apk+data"
		}
		out := base + "-data.zip"
		sort.Slice(data, func(i, j int) bool { return data[i].path < data[j].path })
		if err := writeZip(filepath.Join(dest, out), func(w *zip.Writer) error {
			for _, d := range data {
				if err := copyEntry(w, d.f, d.path, zip.Store); err != nil {
					return err
				}
				if strings.HasSuffix(strings.ToLower(d.path), ".obb") {
					r.ObbFiles = append(r.ObbFiles, d.path)
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
		r.DataFile = out
		if st, err := os.Stat(filepath.Join(dest, out)); err == nil {
			r.DataSize = st.Size()
		}
		if r.PackageName == "" {
			r.Notes = append(r.Notes, "Não deu para descobrir o pacote do jogo pelos dados: informe o nome do pacote (ex.: com.empresa.jogo).")
		}
	}

	// "download" serves the APK alone when there is no data, otherwise the original
	// bundle stays available for people installing by hand.
	if r.DataFile == "" && r.Kind == "apk" {
		r.MainFile = r.ApkFile
	} else {
		r.MainFile = base + ext
		if _, _, err := copyHash(src, filepath.Join(dest, r.MainFile)); err != nil {
			return nil, err
		}
	}
	st, err := os.Stat(filepath.Join(dest, r.MainFile))
	if err != nil {
		return nil, err
	}
	r.Size = st.Size()
	if r.SHA256, err = hashFile(filepath.Join(dest, r.MainFile)); err != nil {
		return nil, err
	}
	return r, nil
}

// androidDataPath maps an entry of an uploaded bundle to its place under the shared
// storage root, or "" when it is not game data.
func androidDataPath(name, pkg string) string {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	for i, p := range parts {
		if strings.EqualFold(p, "Android") && i+2 < len(parts) && (strings.EqualFold(parts[i+1], "obb") || strings.EqualFold(parts[i+1], "data")) {
			return "Android/" + strings.ToLower(parts[i+1]) + "/" + strings.Join(parts[i+2:], "/")
		}
	}
	file := parts[len(parts)-1]
	if m := obbNameRe.FindStringSubmatch(file); m != nil {
		return "Android/obb/" + m[2] + "/" + file
	}
	for i, p := range parts[:len(parts)-1] {
		if pkgRe.MatchString(p) && strings.Count(p, ".") >= 1 && !strings.Contains(p, " ") {
			return "Android/obb/" + p + "/" + strings.Join(parts[i+1:], "/")
		}
	}
	if pkg != "" && strings.HasSuffix(strings.ToLower(file), ".obb") {
		return "Android/obb/" + pkg + "/" + file
	}
	return ""
}

func pkgFromDataPath(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) >= 3 && pkgRe.MatchString(parts[2]) {
		return parts[2]
	}
	return ""
}

// ---------------------------------------------------------------- helpers

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func writeZip(dst string, fill func(*zip.Writer) error) error {
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := zip.NewWriter(f)
	if err := fill(w); err != nil {
		w.Close()
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := w.Close(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func copyEntry(w *zip.Writer, f *zip.File, name string, method uint16) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	hdr := &zip.FileHeader{Name: name, Method: method, Modified: f.Modified}
	hdr.SetMode(0o644)
	dst, err := w.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, rc)
	return err
}

func copyHash(src, dst string) (int64, string, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, "", err
	}
	defer in.Close()
	return writeHash(in, dst)
}

func writeHash(r io.Reader, dst string) (int64, string, error) {
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return 0, "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), r)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return 0, "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashFile is exported for callers that store files without analyzing them (app releases).
func HashFile(p string) (string, error) { return hashFile(p) }
