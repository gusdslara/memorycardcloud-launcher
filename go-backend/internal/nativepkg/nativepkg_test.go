package nativepkg

import (
	"archive/zip"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func makeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := zip.NewWriter(f)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fw, err := w.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		fw.Write([]byte(files[n]))
	}
	w.Close()
	f.Close()
}

func zipNames(t *testing.T, path string) []string {
	t.Helper()
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var out []string
	for _, f := range r.File {
		out = append(out, f.Name)
	}
	sort.Strings(out)
	return out
}

func TestSlug(t *testing.T) {
	if got := Slug("Grand Theft Auto: Vice City"); got != "grand-theft-auto-vice-city" {
		t.Fatal(got)
	}
	if got := Slug("  Ação & Aventura II "); got != "acao-aventura-ii" {
		t.Fatal(got)
	}
}

func TestWindowsZipPicksGameExe(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.zip")
	makeZip(t, src, map[string]string{
		"Carmageddon/CARMA.EXE":           "game binary that is quite big........",
		"Carmageddon/unins000.exe":        "x",
		"Carmageddon/DirectX/DXSETUP.exe": "x",
		"Carmageddon/tools/editor.exe":    "xx",
		"Carmageddon/data/level.dat":      "d",
	})
	r, err := Analyze("windows", src, "Carmageddon.zip", filepath.Join(dir, "out"), "carmageddon-windows")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "zip" || r.Executable != "CARMA.EXE" {
		t.Fatalf("got %+v", r)
	}
	if len(r.Executables) != 2 || r.Executables[1] != "tools/editor.exe" {
		t.Fatalf("candidates %v", r.Executables)
	}
	if r.SHA256 == "" || r.Size == 0 {
		t.Fatal("missing hash/size")
	}
}

func TestAndroidZipWithApkAndObbFolder(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "gta.zip")
	makeZip(t, src, map[string]string{
		"GTA SA/gta-sa.apk": "APK",
		"GTA SA/com.rockstargames.gtasa/main.8.com.rockstargames.gtasa.obb": "OBB",
		"GTA SA/leia-me.txt": "readme",
	})
	out := filepath.Join(dir, "out")
	r, err := Analyze("android", src, "gta.zip", out, "gta-android")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "apk+data" || r.PackageName != "com.rockstargames.gtasa" {
		t.Fatalf("got %+v", r)
	}
	if r.ApkFile != "gta-android.apk" || r.DataFile != "gta-android-data.zip" {
		t.Fatalf("files %+v", r)
	}
	names := zipNames(t, filepath.Join(out, r.DataFile))
	want := "Android/obb/com.rockstargames.gtasa/main.8.com.rockstargames.gtasa.obb"
	if len(names) != 1 || names[0] != want {
		t.Fatalf("data zip %v", names)
	}
	if b, _ := os.ReadFile(filepath.Join(out, r.ApkFile)); string(b) != "APK" {
		t.Fatal("apk content")
	}
}

func TestAndroidXapk(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "game.xapk")
	makeZip(t, src, map[string]string{
		"manifest.json":        `{"package_name":"com.example.game","version_name":"2.1","expansions":[{"file":"Android/obb/com.example.game/main.3.com.example.game.obb","install_path":"Android/obb/com.example.game/main.3.com.example.game.obb"}]}`,
		"com.example.game.apk": "APK",
		"icon.png":             "png",
		"Android/obb/com.example.game/main.3.com.example.game.obb": "OBB",
	})
	r, err := Analyze("android", src, "game.xapk", filepath.Join(dir, "out"), "game-android")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "apk+data" || r.PackageName != "com.example.game" || r.VersionName != "2.1" {
		t.Fatalf("got %+v", r)
	}
	if len(r.ObbFiles) != 1 {
		t.Fatalf("obb %v", r.ObbFiles)
	}
	if r.MainFile != "game-android.xapk" {
		t.Fatalf("main %s", r.MainFile)
	}
}

func TestAndroidZipWithXapkInside(t *testing.T) {
	dir := t.TempDir()
	inner := filepath.Join(dir, "inner.xapk")
	makeZip(t, inner, map[string]string{"manifest.json": `{"package_name":"com.a.b"}`, "base.apk": "APK"})
	b, _ := os.ReadFile(inner)
	src := filepath.Join(dir, "outer.zip")
	makeZip(t, src, map[string]string{"Game/game.xapk": string(b)})
	r, err := Analyze("android", src, "outer.zip", filepath.Join(dir, "out"), "g-android")
	if err != nil {
		t.Fatal(err)
	}
	if r.ApkFile != "g-android.apk" || r.PackageName != "com.a.b" {
		t.Fatalf("got %+v", r)
	}
}

func TestAndroidPlainApkAndSplits(t *testing.T) {
	dir := t.TempDir()
	apk := filepath.Join(dir, "x.apk")
	os.WriteFile(apk, []byte("APK"), 0o644)
	r, err := Analyze("android", apk, "x.apk", filepath.Join(dir, "a"), "x-android")
	if err != nil || r.Kind != "apk" || r.MainFile != "x-android.apk" {
		t.Fatalf("%v %+v", err, r)
	}

	splits := filepath.Join(dir, "s.zip")
	makeZip(t, splits, map[string]string{"base.apk": "A", "split_config.arm64_v8a.apk": "B"})
	r, err = Analyze("android", splits, "s.zip", filepath.Join(dir, "b"), "s-android")
	if err != nil || r.Kind != "split-apk" {
		t.Fatalf("%v %+v", err, r)
	}

	loose := filepath.Join(dir, "l.zip")
	makeZip(t, loose, map[string]string{"game.apk": "A", "main.5.com.loose.game.obb": "O"})
	r, err = Analyze("android", loose, "l.zip", filepath.Join(dir, "c"), "l-android")
	if err != nil || r.PackageName != "com.loose.game" || len(r.ObbFiles) != 1 {
		t.Fatalf("%v %+v", err, r)
	}
}

func TestRejectsUnknownFormats(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.rar")
	os.WriteFile(p, []byte("x"), 0o644)
	if _, err := Analyze("windows", p, "a.rar", dir, "a"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := Analyze("android", p, "a.rar", dir, "a"); err == nil {
		t.Fatal("expected error")
	}
}
