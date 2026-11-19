package handlers

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/nativepkg"
	"go-backend/internal/uploads"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

// Builds of the MemoryCard app itself.
//
//	GET  /api/app/releases                         newest installer per platform (the /baixar page)
//	GET  /api/app/download/:platform               always streams the newest installer, never an old one
//	GET  /api/app/update/:target/:arch/:current    Tauri updater endpoint (204 = up to date)
//
// Files live in APP_RELEASES_DIR/<platform>/<build>-<version>/<file>.

var semverRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$`)

// iOS is accepted ahead of time: builds made on a Mac (scripts/release-app.mjs --platforms ios) can be
// published as soon as the app ships there; the site shows "em breve" until then.
var appPlatforms = map[string]bool{"windows": true, "linux": true, "macos": true, "android": true, "ios": true}

func appReleasesDir() string {
	if d := os.Getenv("APP_RELEASES_DIR"); d != "" {
		return d
	}
	return "./data/app-releases"
}

// compareVersions compares dotted numeric versions ("1.10.0" > "1.9.3"). A version with
// a pre-release suffix is older than the same version without it.
func compareVersions(a, b string) int {
	split := func(v string) ([]int, bool) {
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		pre := false
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			pre = v[i] == '-'
			v = v[:i]
		}
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		return out, pre
	}
	pa, preA := split(a)
	pb, preB := split(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	switch {
	case preA && !preB:
		return -1
	case !preA && preB:
		return 1
	}
	return 0
}

// latestRelease returns the newest release for a platform with one of the roles
// (highest build number; the newest upload wins a tie).
func latestRelease(platform string, roles ...string) (*models.AppRelease, error) {
	var r models.AppRelease
	err := database.DB.Where("platform = ? AND role IN ?", platform, roles).
		Order("build desc").Order("created_at desc").Order("id desc").First(&r).Error
	if err != nil {
		return nil, err
	}
	return &r, nil
}

type publicRelease struct {
	Platform string    `json:"platform"`
	Version  string    `json:"version"`
	Build    int       `json:"build"`
	Date     time.Time `json:"date"`
	FileName string    `json:"file_name"`
	Size     int64     `json:"size"`
	SHA256   string    `json:"sha256"`
	Arch     string    `json:"arch"`
	Notes    string    `json:"notes,omitempty"`
	URL      string    `json:"url"`
}

func toPublic(r *models.AppRelease) publicRelease {
	return publicRelease{
		Platform: r.Platform, Version: r.Version, Build: r.Build, Date: r.CreatedAt,
		FileName: r.FileName, Size: r.Size, SHA256: r.SHA256, Arch: r.Arch, Notes: r.Notes,
		URL: "/api/app/download/" + r.Platform,
	}
}

// GET /api/app/releases
func GetAppReleases(c *fiber.Ctx) error {
	out := map[string]publicRelease{}
	for p := range appPlatforms {
		if r, err := latestRelease(p, "installer", "both"); err == nil {
			out[p] = toPublic(r)
		}
	}
	c.Set("Cache-Control", "no-cache")
	return c.JSON(out)
}

// GET /api/app/download/:platform
func DownloadLatestApp(c *fiber.Ctx) error {
	platform := c.Params("platform")
	if !appPlatforms[platform] {
		return c.SendStatus(404)
	}
	r, err := latestRelease(platform, "installer", "both")
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Ainda não há build publicada para " + platform})
	}
	p := filepath.Join(appReleasesDir(), r.Stored)
	if _, err := os.Stat(p); err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Arquivo da build não encontrado no servidor"})
	}
	c.Set("Cache-Control", "no-store")
	c.Set("X-App-Version", r.Version)
	c.Set("X-App-Build", strconv.Itoa(r.Build))
	c.Set("X-Content-SHA256", r.SHA256)
	if strings.HasSuffix(strings.ToLower(r.FileName), ".apk") {
		c.Set(fiber.HeaderContentType, "application/vnd.android.package-archive")
	}
	return c.Download(p, r.FileName)
}

// GET /api/app/file/:id  (a specific build; used by the updater bundle URL)
func DownloadAppFile(c *fiber.Ctx) error {
	id, _ := strconv.Atoi(c.Params("id"))
	var r models.AppRelease
	if err := database.DB.First(&r, id).Error; err != nil {
		return c.SendStatus(404)
	}
	c.Set("Cache-Control", "public, max-age=31536000, immutable")
	return c.Download(filepath.Join(appReleasesDir(), r.Stored), r.FileName)
}

// GET /api/app/update/:target/:arch/:current  (Tauri v2 updater, dynamic server format)
func AppUpdateCheck(c *fiber.Ctx) error {
	target := c.Params("target")
	platform := map[string]string{"windows": "windows", "linux": "linux", "darwin": "macos", "macos": "macos"}[target]
	if platform == "" {
		return c.SendStatus(204)
	}
	r, err := latestRelease(platform, "updater", "both")
	if err != nil || r.Signature == "" || compareVersions(r.Version, c.Params("current")) <= 0 {
		return c.SendStatus(204)
	}
	base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/")
	if base == "" {
		base = c.BaseURL()
	}
	base = strings.TrimSuffix(base, "/api")
	return c.JSON(fiber.Map{
		"version":   strings.TrimPrefix(r.Version, "v"),
		"notes":     r.Notes,
		"pub_date":  r.CreatedAt.UTC().Format(time.RFC3339),
		"url":       fmt.Sprintf("%s/api/app/file/%d", base, r.ID),
		"signature": r.Signature,
	})
}

// ------------------------------------------------------------------ admin

// GET /api/admin/app-releases
func AdminListAppReleases(c *fiber.Ctx) error {
	var list []models.AppRelease
	database.DB.Order("build desc").Order("created_at desc").Limit(200).Find(&list)
	for i := range list {
		list[i].HasSig = list[i].Signature != ""
	}
	return c.JSON(list)
}

// POST /api/admin/app-releases
// {"platform":"windows","version":"0.2.0","build":12,"role":"both","notes":"…","signature":"…","upload_id":"…","arch":"x86_64"}
func AdminCreateAppRelease(c *fiber.Ctx) error {
	var req struct {
		Platform  string `json:"platform"`
		Arch      string `json:"arch"`
		Version   string `json:"version"`
		Build     int    `json:"build"`
		Role      string `json:"role"`
		Notes     string `json:"notes"`
		Signature string `json:"signature"`
		UploadID  string `json:"upload_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"message": "JSON inválido"})
	}
	req.Version = strings.TrimPrefix(strings.TrimSpace(req.Version), "v")
	if !appPlatforms[req.Platform] || !semverRe.MatchString(req.Version) {
		return c.Status(400).JSON(fiber.Map{"message": "Informe a plataforma e a versão (ex.: 0.2.0)"})
	}
	if req.Role == "" {
		req.Role = "both"
	}
	if req.Role != "installer" && req.Role != "updater" && req.Role != "both" {
		return c.Status(400).JSON(fiber.Map{"message": "role deve ser installer, updater ou both"})
	}
	if req.Build <= 0 {
		// Next build number for this platform
		var max int
		database.DB.Model(&models.AppRelease{}).Where("platform = ?", req.Platform).Select("COALESCE(MAX(build), 0)").Scan(&max)
		req.Build = max + 1
	}
	src, up, err := uploads.Default().Take(adminUserID(c), req.UploadID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"message": err.Error()})
	}
	defer uploads.Default().Done(req.UploadID)

	rel := filepath.Join(req.Platform, fmt.Sprintf("%05d-%s", req.Build, req.Version), up.FileName)
	dst := filepath.Join(appReleasesDir(), rel)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	if err := moveFile(src, dst); err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	sum, err := nativepkg.HashFile(dst)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	r := models.AppRelease{
		Platform: req.Platform, Arch: req.Arch, Version: req.Version, Build: req.Build, Role: req.Role,
		FileName: up.FileName, Stored: rel, Size: up.Size, SHA256: sum,
		Signature: strings.TrimSpace(req.Signature), Notes: strings.TrimSpace(req.Notes),
	}
	if err := database.DB.Create(&r).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	r.HasSig = r.Signature != ""
	return c.Status(201).JSON(r)
}

// DELETE /api/admin/app-releases/:id
func AdminDeleteAppRelease(c *fiber.Ctx) error {
	id, _ := strconv.Atoi(c.Params("id"))
	var r models.AppRelease
	if err := database.DB.First(&r, id).Error; err != nil {
		return c.SendStatus(404)
	}
	os.Remove(filepath.Join(appReleasesDir(), r.Stored))
	os.Remove(filepath.Dir(filepath.Join(appReleasesDir(), r.Stored)))
	database.DB.Delete(&r)
	return c.SendStatus(204)
}

func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// different volume: copy
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst + ".part")
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(dst+".part", dst)
}
