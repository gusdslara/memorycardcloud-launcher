package handlers

import (
	"context"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/internal/romcache"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

// --- Library folders: which Drive folder is which console, how games are laid out, who uses it ---

func normLayout(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case gdrive.LayoutLoose:
		return gdrive.LayoutLoose
	case gdrive.LayoutFolders:
		return gdrive.LayoutFolders
	}
	return gdrive.LayoutAuto
}

// normConsole keeps "" (automatic) or maps names like "playstation" to the library code.
func normConsole(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "auto") {
		return ""
	}
	return gdrive.ConsoleFromFolder(s)
}

func driveFolderID(s string) string {
	id := strings.TrimSpace(s)
	if i := strings.Index(id, "folders/"); i >= 0 { // pasted a Drive URL
		id = strings.SplitN(id[i+len("folders/"):], "?", 2)[0]
	}
	return id
}

func triggerSync() {
	if romcache.Default != nil {
		romcache.Default.Trigger(true)
	}
}

// AdminGDriveBrowse ?parent=<id|root>: folders and files of a Drive folder, with the console
// recognised from each folder name and the library folders already mapped.
func AdminGDriveBrowse(c *fiber.Ctx) error {
	svc, _, err := connectedDrive(c)
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	parent := c.Query("parent", "root")
	entries, err := svc.ListChildren(c.UserContext(), parent)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": err.Error()})
	}
	var sources []models.RomSource
	database.DB.Find(&sources)
	mapped := map[string]models.RomSource{}
	for _, s := range sources {
		mapped[s.FolderID] = s
	}
	type entry struct {
		gdrive.DriveEntry
		SourceID      uint   `json:"source_id,omitempty"`
		SourceConsole string `json:"source_console,omitempty"`
	}
	out := make([]entry, 0, len(entries))
	files, folders := 0, 0
	var bytes int64
	for _, e := range entries {
		x := entry{DriveEntry: e}
		if s, ok := mapped[e.ID]; ok {
			x.SourceID, x.SourceConsole = s.ID, s.Console
			if s.Console == "" {
				x.SourceConsole = "auto"
			}
		}
		if e.Folder {
			folders++
		} else {
			files++
			bytes += e.Size
		}
		out = append(out, x)
	}
	resp := fiber.Map{"entries": out, "folders": folders, "files": files, "bytes": bytes}
	if s, ok := mapped[parent]; ok {
		resp["source"] = s
	}
	return c.JSON(resp)
}

// AdminGDrivePreview ?folder_id&console&layout: what the library would find in a folder
// (consoles, games in their own folder vs loose files) before saving it.
func AdminGDrivePreview(c *fiber.Ctx) error {
	svc, _, err := connectedDrive(c)
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	id := driveFolderID(c.Query("folder_id"))
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "folder_id obrigatório"})
	}
	// other library folders inside this one are shown separately
	var sources []models.RomSource
	database.DB.Where("folder_id <> ?", id).Find(&sources)
	skip := map[string]bool{}
	for _, s := range sources {
		skip[s.FolderID] = true
	}
	ctx, cancel := context.WithTimeout(c.UserContext(), 90*time.Second)
	defer cancel()
	items, err := svc.ScanSource(ctx, id, gdrive.ScanOptions{Console: normConsole(c.Query("console")), Layout: normLayout(c.Query("layout")), Skip: skip, MaxDepth: 6})
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": err.Error()})
	}
	var bytes int64
	for _, it := range items {
		bytes += it.SizeBytes
	}
	return c.JSON(fiber.Map{"files": len(items), "bytes": bytes, "consoles": gdrive.Summarize(items, 6)})
}

type sourceRow struct {
	models.RomSource
	Files  int64 `json:"files"`
	Games  int64 `json:"games"`
	Bytes  int64 `json:"bytes"`
	Cached int64 `json:"cached"`
}

// AdminRomSources: library folders with what was found in each.
func AdminRomSources(c *fiber.Ctx) error {
	romcache.EnsureSources()
	var sources []models.RomSource
	database.DB.Order("id").Find(&sources)
	type agg struct {
		SourceID uint
		Files    int64
		Games    int64
		Bytes    int64
		Cached   int64
	}
	var aggs []agg
	database.DB.Model(&models.RomItem{}).Where("is_available = ?", true).
		Select("source_id, COUNT(*) AS files, COUNT(DISTINCT COALESCE(NULLIF(game_key,''), drive_file_id)) AS games, COALESCE(SUM(size_bytes),0) AS bytes, SUM(CASE WHEN cache_status = 'cached' THEN 1 ELSE 0 END) AS cached").
		Group("source_id").Scan(&aggs)
	by := map[uint]agg{}
	for _, a := range aggs {
		by[a.SourceID] = a
	}
	rows := make([]sourceRow, 0, len(sources))
	for _, s := range sources {
		a := by[s.ID]
		rows = append(rows, sourceRow{RomSource: s, Files: a.Files, Games: a.Games, Bytes: a.Bytes, Cached: a.Cached})
	}
	return c.JSON(fiber.Map{"sources": rows, "consoles": gdrive.Consoles})
}

// AdminAddRomSource {folder_id, folder_path?, console?, layout?}: adds (or updates) a library folder.
func AdminAddRomSource(c *fiber.Ctx) error {
	var req struct {
		FolderID   string `json:"folder_id"`
		FolderPath string `json:"folder_path"`
		Console    string `json:"console"`
		Layout     string `json:"layout"`
	}
	if err := c.BodyParser(&req); err != nil || driveFolderID(req.FolderID) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "folder_id obrigatório"})
	}
	id := driveFolderID(req.FolderID)
	svc, cfg, err := connectedDrive(c)
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	name, err := svc.FolderName(c.UserContext(), id)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	var src models.RomSource
	database.DB.Where("folder_id = ?", id).First(&src)
	src.FolderID, src.FolderName = id, name
	if p := strings.TrimSpace(req.FolderPath); p != "" {
		src.FolderPath = p
	} else if src.FolderPath == "" {
		src.FolderPath = name
	}
	src.Console, src.Layout = normConsole(req.Console), normLayout(req.Layout)
	if src.ID == 0 {
		database.DB.Create(&src)
	} else {
		database.DB.Save(&src)
	}
	if cfg.FolderID == "" { // first folder: keeps the old single-folder fields meaningful
		cfg.FolderID, cfg.FolderName, cfg.UpdatedAt = id, name, time.Now()
		database.DB.Save(cfg)
	}
	triggerSync()
	return c.JSON(fiber.Map{"message": "Pasta adicionada", "source": src})
}

// AdminUpdateRomSource {console?, layout?}
func AdminUpdateRomSource(c *fiber.Ctx) error {
	var src models.RomSource
	if err := database.DB.First(&src, c.Params("id")).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Pasta não encontrada"})
	}
	var req struct {
		Console *string `json:"console"`
		Layout  *string `json:"layout"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Pedido inválido"})
	}
	if req.Console != nil {
		src.Console = normConsole(*req.Console)
	}
	if req.Layout != nil {
		src.Layout = normLayout(*req.Layout)
	}
	database.DB.Save(&src)
	triggerSync()
	return c.JSON(fiber.Map{"message": "Pasta atualizada", "source": src})
}

// AdminDeleteRomSource: the folder leaves the library (its files become unavailable on the next sync).
func AdminDeleteRomSource(c *fiber.Ctx) error {
	var src models.RomSource
	if err := database.DB.First(&src, c.Params("id")).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Pasta não encontrada"})
	}
	database.DB.Delete(&src)
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if cfg.ID != 0 && cfg.FolderID == src.FolderID {
		var next models.RomSource
		database.DB.Order("id").First(&next)
		cfg.FolderID, cfg.FolderName, cfg.UpdatedAt = next.FolderID, next.FolderName, time.Now()
		database.DB.Save(&cfg)
	}
	// hide its files right away instead of waiting for the next sync
	database.DB.Model(&models.RomItem{}).Where("source_id = ?", src.ID).Update("is_available", false)
	triggerSync()
	return c.JSON(fiber.Map{"message": "Pasta removida da biblioteca"})
}

// AdminRomsUsers ?q=: accounts to pick from when granting the library (granted ones first).
func AdminRomsUsers(c *fiber.Ctx) error {
	db := database.DB.Model(&models.User{})
	if q := strings.ToLower(strings.TrimSpace(c.Query("q"))); q != "" {
		like := "%" + q + "%"
		db = db.Where("LOWER(email) LIKE ? OR LOWER(name) LIKE ?", like, like)
	}
	var total int64
	db.Count(&total)
	var users []models.User
	db.Order("is_admin DESC, roms_access DESC, LOWER(COALESCE(NULLIF(name,''), email))").Limit(100).Find(&users)
	out := make([]fiber.Map, 0, len(users))
	for _, u := range users {
		out = append(out, fiber.Map{"id": u.ID, "email": u.Email, "name": u.Name, "is_admin": u.IsAdmin, "roms_access": u.RomsAccess, "subscription_plan": u.SubscriptionPlan, "created_at": u.CreatedAt})
	}
	return c.JSON(fiber.Map{"users": out, "total": total})
}
