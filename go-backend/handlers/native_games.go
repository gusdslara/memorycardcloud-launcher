package handlers

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go-backend/database"
	"go-backend/internal/nativepkg"
	"go-backend/internal/uploads"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// Native games (abandonware and native builds) uploaded by the superadmin.
// Public: list + downloads. Admin: create/edit/delete, cover, one build per platform.

var nativePlatforms = map[string]bool{"windows": true, "linux": true, "macos": true, "android": true, "ios": true}
var slugOK = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,80}$`)

func nativeDir() string {
	if d := os.Getenv("NATIVE_GAMES_DIR"); d != "" {
		return d
	}
	base := os.Getenv("DATA_DIR")
	if base == "" {
		base = "./data"
	}
	return filepath.Join(base, "native-games")
}

func decorateNative(g *models.NativeGame) {
	switch {
	case strings.HasPrefix(g.CoverFile, "http://") || strings.HasPrefix(g.CoverFile, "https://"):
		g.CoverURL = g.CoverFile
	case g.CoverFile != "":
		g.CoverURL = fmt.Sprintf("/api/native-games/%s/cover?v=%d", g.Slug, g.UpdatedAt.Unix())
	}
	for i := range g.Builds {
		b := &g.Builds[i]
		base := fmt.Sprintf("/api/native-games/%s/%s/", g.Slug, b.Platform)
		b.DownloadURL = base + "download"
		if b.ApkFile != "" {
			b.ApkURL = base + "apk"
		}
		if b.DataFile != "" {
			b.DataURL = base + "data"
		}
	}
}

func findNative(slug string, withUnpublished bool) (*models.NativeGame, error) {
	var g models.NativeGame
	q := database.DB.Preload("Builds")
	if !withUnpublished {
		q = q.Where("published = ?", true)
	}
	if err := q.Where("slug = ?", slug).First(&g).Error; err != nil {
		return nil, err
	}
	return &g, nil
}

// GET /api/native-games?platform=windows
func ListNativeGames(c *fiber.Ctx) error {
	var games []models.NativeGame
	if err := database.DB.Preload("Builds").Where("published = ?", true).Order("title").Find(&games).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	platform := c.Query("platform")
	out := make([]models.NativeGame, 0, len(games))
	for _, g := range games {
		if platform != "" {
			keep := g.Builds[:0:0]
			for _, b := range g.Builds {
				if b.Platform == platform {
					keep = append(keep, b)
				}
			}
			if len(keep) == 0 {
				continue
			}
			g.Builds = keep
		}
		if len(g.Builds) == 0 {
			continue
		}
		decorateNative(&g)
		out = append(out, g)
	}
	c.Set("Cache-Control", "public, max-age=60")
	return c.JSON(out)
}

// GET /api/native-games/:slug
func GetNativeGame(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), false)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	decorateNative(g)
	return c.JSON(g)
}

// GET /api/native-games/:slug/cover
func NativeGameCover(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil || g.CoverFile == "" || strings.HasPrefix(g.CoverFile, "http") {
		return c.SendStatus(404)
	}
	c.Set("Cache-Control", "public, max-age=604800")
	return c.SendFile(filepath.Join(nativeDir(), g.Slug, g.CoverFile))
}

// GET /api/native-games/:slug/:platform/:file  (file = download | apk | data)
func DownloadNativeGame(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), false)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	platform := c.Params("platform")
	for _, b := range g.Builds {
		if b.Platform != platform {
			continue
		}
		stored, name := b.StoredFile, b.FileName
		switch c.Params("file") {
		case "apk":
			stored, name = b.ApkFile, g.Slug+filepath.Ext(b.ApkFile)
		case "data":
			stored, name = b.DataFile, g.Slug+"-data.zip"
		case "download":
		default:
			return c.SendStatus(404)
		}
		if stored == "" {
			return c.SendStatus(404)
		}
		p := filepath.Join(nativeDir(), g.Slug, platform, stored)
		if _, err := os.Stat(p); err != nil {
			return c.Status(404).JSON(fiber.Map{"message": "Arquivo não está no servidor"})
		}
		if strings.HasSuffix(strings.ToLower(name), ".apk") {
			c.Set(fiber.HeaderContentType, "application/vnd.android.package-archive")
		}
		c.Set("X-Content-SHA256", b.SHA256)
		return c.Download(p, name)
	}
	return c.Status(404).JSON(fiber.Map{"message": "Sem versão para essa plataforma"})
}

// ------------------------------------------------------------------ admin

type nativeGameInput struct {
	Title       *string `json:"title"`
	Slug        *string `json:"id"`
	Developer   *string `json:"developer"`
	Publisher   *string `json:"publisher"`
	Year        *int    `json:"year"`
	Genre       *string `json:"genre"`
	Description *string `json:"description"`
	CoverURL    *string `json:"cover_url"`
	Published   *bool   `json:"published"`
}

func (in nativeGameInput) apply(g *models.NativeGame) {
	set := func(dst *string, v *string) {
		if v != nil {
			*dst = strings.TrimSpace(*v)
		}
	}
	set(&g.Title, in.Title)
	set(&g.Developer, in.Developer)
	set(&g.Publisher, in.Publisher)
	set(&g.Genre, in.Genre)
	set(&g.Description, in.Description)
	if in.Year != nil {
		g.Year = *in.Year
	}
	if in.Published != nil {
		g.Published = *in.Published
	}
	if in.CoverURL != nil && strings.HasPrefix(strings.TrimSpace(*in.CoverURL), "http") {
		g.CoverFile = strings.TrimSpace(*in.CoverURL)
	}
}

// GET /api/admin/native-games
func AdminListNativeGames(c *fiber.Ctx) error {
	var games []models.NativeGame
	database.DB.Preload("Builds").Order("updated_at desc").Find(&games)
	for i := range games {
		decorateNative(&games[i])
	}
	return c.JSON(games)
}

// POST /api/admin/native-games
func AdminCreateNativeGame(c *fiber.Ctx) error {
	var in nativeGameInput
	if err := c.BodyParser(&in); err != nil || in.Title == nil || strings.TrimSpace(*in.Title) == "" {
		return c.Status(400).JSON(fiber.Map{"message": "Informe o título"})
	}
	g := models.NativeGame{Published: true}
	in.apply(&g)
	g.Slug = nativepkg.Slug(g.Title)
	if in.Slug != nil && strings.TrimSpace(*in.Slug) != "" {
		g.Slug = nativepkg.Slug(*in.Slug)
	}
	if !slugOK.MatchString(g.Slug) {
		return c.Status(400).JSON(fiber.Map{"message": "Id inválido"})
	}
	var n int64
	database.DB.Model(&models.NativeGame{}).Where("slug = ?", g.Slug).Count(&n)
	if n > 0 {
		return c.Status(409).JSON(fiber.Map{"message": "Já existe um jogo com esse id: " + g.Slug})
	}
	if err := database.DB.Create(&g).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	decorateNative(&g)
	return c.Status(201).JSON(g)
}

// PUT /api/admin/native-games/:slug
func AdminUpdateNativeGame(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	var in nativeGameInput
	if err := c.BodyParser(&in); err != nil {
		return c.Status(400).JSON(fiber.Map{"message": "JSON inválido"})
	}
	in.apply(g)
	if err := database.DB.Omit("Builds").Save(g).Error; err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	decorateNative(g)
	return c.JSON(g)
}

// DELETE /api/admin/native-games/:slug
func AdminDeleteNativeGame(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	database.DB.Where("game_id = ?", g.ID).Delete(&models.NativeBuild{})
	database.DB.Delete(g)
	os.RemoveAll(filepath.Join(nativeDir(), g.Slug))
	return c.SendStatus(204)
}

// POST /api/admin/native-games/:slug/cover  (multipart "cover", image up to 10 MB)
func AdminUploadNativeCover(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	fh, err := c.FormFile("cover")
	if err != nil || fh.Size > 10<<20 {
		return c.Status(400).JSON(fiber.Map{"message": "Envie uma imagem de até 10 MB no campo cover"})
	}
	ext := strings.ToLower(filepath.Ext(fh.Filename))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
		return c.Status(400).JSON(fiber.Map{"message": "Use JPG, PNG ou WebP"})
	}
	dir := filepath.Join(nativeDir(), g.Slug)
	os.MkdirAll(dir, 0o755)
	name := "cover" + ext
	if err := c.SaveFile(fh, filepath.Join(dir, name)); err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	g.CoverFile = name
	database.DB.Omit("Builds").Save(g)
	decorateNative(g)
	return c.JSON(g)
}

// POST /api/admin/native-games/:slug/builds
// {"platform": "android", "upload_id": "...", "version": "1.0", "executable": "", "package_name": ""}
func AdminAddNativeBuild(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	var req struct {
		Platform    string `json:"platform"`
		UploadID    string `json:"upload_id"`
		Version     string `json:"version"`
		Executable  string `json:"executable"`
		PackageName string `json:"package_name"`
	}
	if err := c.BodyParser(&req); err != nil || !nativePlatforms[req.Platform] {
		return c.Status(400).JSON(fiber.Map{"message": "Informe a plataforma e o upload"})
	}
	src, up, err := uploads.Default().Take(adminUserID(c), req.UploadID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"message": err.Error()})
	}
	defer uploads.Default().Done(req.UploadID)

	dir := filepath.Join(nativeDir(), g.Slug, req.Platform)
	staging := dir + ".new"
	os.RemoveAll(staging)
	res, err := nativepkg.Analyze(req.Platform, src, up.FileName, staging, g.Slug+"-"+req.Platform)
	if err != nil {
		os.RemoveAll(staging)
		status := 500
		if errors.Is(err, nativepkg.ErrUnsupported) {
			status = 400
		}
		return c.Status(status).JSON(fiber.Map{"message": err.Error()})
	}
	// Swap the folder only after the new build is fully written.
	os.RemoveAll(dir)
	if err := os.Rename(staging, dir); err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}

	b := models.NativeBuild{
		GameID:      g.ID,
		Platform:    req.Platform,
		Kind:        res.Kind,
		FileName:    g.Slug + "-" + req.Platform + filepath.Ext(res.MainFile),
		StoredFile:  res.MainFile,
		Size:        res.Size,
		SHA256:      res.SHA256,
		Version:     strings.TrimSpace(req.Version),
		Executable:  res.Executable,
		Executables: res.Executables,
		PackageName: res.PackageName,
		ApkFile:     res.ApkFile,
		DataFile:    res.DataFile,
		DataSize:    res.DataSize,
		ObbFiles:    res.ObbFiles,
		Notes:       res.Notes,
	}
	if req.Executable != "" {
		b.Executable = req.Executable
	}
	if req.PackageName != "" {
		b.PackageName = req.PackageName
	}
	if b.Version == "" {
		b.Version = res.VersionName
	}
	err = database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("game_id = ? AND platform = ?", g.ID, req.Platform).Delete(&models.NativeBuild{}).Error; err != nil {
			return err
		}
		if err := tx.Create(&b).Error; err != nil {
			return err
		}
		return tx.Model(g).Update("updated_at", b.CreatedAt).Error
	})
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"message": err.Error()})
	}
	g, _ = findNative(g.Slug, true)
	decorateNative(g)
	return c.Status(201).JSON(g)
}

// PUT /api/admin/native-games/:slug/builds/:platform  {"executable": "...", "package_name": "...", "version": "..."}
func AdminUpdateNativeBuild(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	var req struct {
		Executable  *string `json:"executable"`
		PackageName *string `json:"package_name"`
		Version     *string `json:"version"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"message": "JSON inválido"})
	}
	upd := map[string]interface{}{}
	if req.Executable != nil {
		upd["executable"] = strings.TrimSpace(*req.Executable)
	}
	if req.PackageName != nil {
		upd["package_name"] = strings.TrimSpace(*req.PackageName)
	}
	if req.Version != nil {
		upd["version"] = strings.TrimSpace(*req.Version)
	}
	database.DB.Model(&models.NativeBuild{}).Where("game_id = ? AND platform = ?", g.ID, c.Params("platform")).Updates(upd)
	g, _ = findNative(g.Slug, true)
	decorateNative(g)
	return c.JSON(g)
}

// DELETE /api/admin/native-games/:slug/builds/:platform
func AdminDeleteNativeBuild(c *fiber.Ctx) error {
	g, err := findNative(c.Params("slug"), true)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"message": "Jogo não encontrado"})
	}
	platform := c.Params("platform")
	if !nativePlatforms[platform] {
		return c.SendStatus(400)
	}
	database.DB.Where("game_id = ? AND platform = ?", g.ID, platform).Delete(&models.NativeBuild{})
	os.RemoveAll(filepath.Join(nativeDir(), g.Slug, platform))
	return c.SendStatus(204)
}
