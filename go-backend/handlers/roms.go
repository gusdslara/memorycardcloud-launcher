package handlers

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/internal/romcache"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

// RequireRomsAccessMiddleware: the ROM library is private. Only superadmins and the accounts a
// superadmin explicitly granted (Users → "Biblioteca de ROMs") get in. No paid plan unlocks it.
func RequireRomsAccessMiddleware(c *fiber.Ctx) error {
	userToken, ok := c.Locals("user").(*jwt.Token)
	if !ok || userToken == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Authentication required", "code": "AUTH_REQUIRED"})
	}
	claims, ok := userToken.Claims.(jwt.MapClaims)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Invalid token claims", "code": "INVALID_CLAIMS"})
	}
	var user models.User
	if err := database.DB.First(&user, claims["sub"]).Error; err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "User not found", "code": "USER_NOT_FOUND"})
	}
	if !user.IsAdmin && !user.RomsAccess {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"message": "Biblioteca privada. O acesso é liberado pelo administrador.",
			"code":    "ROMS_ACCESS_DENIED",
		})
	}
	c.Locals("currentUser", &user)
	return c.Next()
}

// GetRoms lists ROMs/ISOs with search and console filtering
func GetRoms(c *fiber.Ctx) error {
	// Ensure defaults are seeded if table is empty
	var count int64
	database.DB.Model(&models.RomItem{}).Count(&count)
	if count == 0 {
		SeedDefaultRoms()
	}

	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "24"))
	if page < 1 {
		page = 1
	}
	maxLimit := 100
	if c.Query("all") == "1" { // the app matches ports against the whole library at once
		maxLimit = 5000
	}
	if limit < 1 || limit > maxLimit {
		limit = 24
	}
	offset := (page - 1) * limit

	query := strings.TrimSpace(c.Query("q"))
	consoleFilter := strings.TrimSpace(c.Query("console"))
	extensionFilter := strings.TrimSpace(c.Query("extension"))

	db := database.DB.Model(&models.RomItem{}).Where("is_available = ?", true)

	if query != "" {
		search := "%" + strings.ToLower(query) + "%"
		db = db.Where("LOWER(name) LIKE ? OR LOWER(console) LIKE ? OR LOWER(game_title) LIKE ?", search, search, search)
	}

	if consoleFilter != "" && !strings.EqualFold(consoleFilter, "all") {
		db = db.Where("LOWER(console) = LOWER(?)", consoleFilter)
	}

	if extensionFilter != "" && !strings.EqualFold(extensionFilter, "all") {
		if !strings.HasPrefix(extensionFilter, ".") {
			extensionFilter = "." + extensionFilter
		}
		db = db.Where("LOWER(extension) = LOWER(?)", extensionFilter)
	}

	if c.Query("group") == "games" {
		return listGames(c, db, page, limit, offset)
	}

	var total int64
	db.Count(&total)

	var roms []models.RomItem
	db.Order("name ASC").Limit(limit).Offset(offset).Find(&roms)

	lastPage := 1
	if limit > 0 && total > 0 {
		lastPage = int((total + int64(limit) - 1) / int64(limit))
	}

	// Fetch current Google Drive config summary
	var gdriveCfg models.GoogleDriveConfig
	database.DB.First(&gdriveCfg)

	return c.JSON(fiber.Map{
		"roms":            roms,
		"total":           total,
		"page":            page,
		"last_page":       lastPage,
		"has_roms_access": true,
		"storage_drive": fiber.Map{
			"folder_id":            gdriveCfg.FolderID,
			"last_synced_at":       gdriveCfg.LastSyncedAt,
			"total_files_count":    gdriveCfg.TotalFilesCount,
			"total_size_formatted": gdriveCfg.TotalSizeFormatted,
		},
	})
}

// RomGame is one game of the library with all its files (a .cue + its .bin tracks, a game folder…).
type RomGame struct {
	Key           string           `json:"key"`
	Title         string           `json:"title"`
	Console       string           `json:"console"`
	Folder        bool             `json:"folder"` // lives in its own folder: download into <console>/<title>/
	Parts         int              `json:"parts"`
	SizeBytes     int64            `json:"size_bytes"`
	SizeFormatted string           `json:"size_formatted"`
	Main          string           `json:"main"` // path of the file a launcher opens
	Files         []models.RomItem `json:"files"`
}

const gameKeyExpr = "COALESCE(NULLIF(game_key,''), drive_file_id)"

// listGames paginates over games instead of files (?group=games).
func listGames(c *fiber.Ctx, db *gorm.DB, page, limit, offset int) error {
	type row struct {
		GK    string
		Title string
	}
	var total int64
	database.DB.Table("(?) AS g", db.Session(&gorm.Session{}).Select(gameKeyExpr+" AS gk").Group(gameKeyExpr)).Count(&total)
	var rows []row
	db.Session(&gorm.Session{}).Select(gameKeyExpr + " AS gk, MIN(COALESCE(NULLIF(game_title,''), name)) AS title").
		Group(gameKeyExpr).Order("LOWER(title) ASC").Limit(limit).Offset(offset).Scan(&rows)
	keys := make([]string, 0, len(rows))
	for _, r := range rows {
		keys = append(keys, r.GK)
	}
	var files []models.RomItem
	if len(keys) > 0 {
		database.DB.Where("is_available = ? AND "+gameKeyExpr+" IN ?", true, keys).Order("game_path ASC, name ASC").Find(&files)
	}
	byKey := map[string]*RomGame{}
	for _, f := range files {
		k := f.GameKey
		if k == "" {
			k = f.DriveFileID
		}
		g, ok := byKey[k]
		if !ok {
			title := f.GameTitle
			if title == "" {
				title = strings.TrimSuffix(f.Name, filepath.Ext(f.Name))
			}
			g = &RomGame{Key: k, Title: title, Console: f.Console, Folder: f.GameFolder}
			byKey[k] = g
		}
		if f.GamePath == "" {
			f.GamePath = f.Name
		}
		g.Files = append(g.Files, f)
		g.Parts++
		g.SizeBytes += f.SizeBytes
		if f.GameMain || g.Main == "" {
			g.Main = f.GamePath
		}
	}
	games := make([]RomGame, 0, len(rows))
	for _, r := range rows {
		if g, ok := byKey[r.GK]; ok {
			g.SizeFormatted = gdrive.FormatBytes(g.SizeBytes)
			games = append(games, *g)
		}
	}
	lastPage := 1
	if limit > 0 && total > 0 {
		lastPage = int((total + int64(limit) - 1) / int64(limit))
	}
	return c.JSON(fiber.Map{"games": games, "total": total, "page": page, "last_page": lastPage, "has_roms_access": true})
}

// DownloadRom handles direct file streaming bypass for Google Drive files
func DownloadRom(c *fiber.Ctx) error {
	idOrFileID := c.Params("id")
	if idOrFileID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "ROM ID or Drive File ID required"})
	}

	var rom models.RomItem
	// Try finding by primary key ID or drive_file_id
	if err := database.DB.Where("(id = ? OR drive_file_id = ?) AND is_available = ?", idOrFileID, idOrFileID, true).First(&rom).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "ROM not found"})
	}

	// Fast path: the copy on the server's SSD (Range requests supported for resumable downloads).
	if romcache.Default != nil {
		if path, ok := romcache.Default.LocalFile(rom); ok {
			c.Set("Cache-Control", "private, max-age=3600")
			return c.Download(path, rom.Name)
		}
	}

	// Not mirrored yet: stream straight from Google Drive and queue the SSD copy.
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if romcache.Default != nil {
		romcache.Default.Trigger(false)
	}
	service := gdrive.NewDriveService(cfg)
	return service.StreamDownload(c, rom.DriveFileID, rom.Name, rom.SizeBytes)
}

// GetRomDirectLink returns direct links and UC link bypassing the Google Drive virus confirmation page
func GetRomDirectLink(c *fiber.Ctx) error {
	idOrFileID := c.Params("id")
	var rom models.RomItem
	if err := database.DB.Where("id = ? OR drive_file_id = ?", idOrFileID, idOrFileID).First(&rom).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "ROM not found"})
	}

	directURL := gdrive.GenerateDirectDownloadURL(rom.DriveFileID)
	ucURL := gdrive.GenerateUcURL(rom.DriveFileID)

	return c.JSON(fiber.Map{
		"id":                rom.ID,
		"drive_file_id":     rom.DriveFileID,
		"name":              rom.Name,
		"console":           rom.Console,
		"extension":         rom.Extension,
		"size_formatted":    rom.SizeFormatted,
		"direct_gdrive_url": directURL,
		"uc_url":            ucURL,
		"download_url":      fmt.Sprintf("/api/roms/%s/download", rom.DriveFileID),
	})
}

// --- Admin Google Drive Handlers ---

// AdminGetGDriveConfig returns current drive settings
func AdminGetGDriveConfig(c *fiber.Ctx) error {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)

	// Fallback to env if empty
	if cfg.FolderID == "" {
		cfg.FolderID = os.Getenv("GDRIVE_ROMS_FOLDER_ID")
	}
	if cfg.APIKey == "" {
		cfg.APIKey = os.Getenv("GDRIVE_API_KEY")
	}

	var totalFiles int64
	var totalBytes int64
	database.DB.Model(&models.RomItem{}).Count(&totalFiles)
	database.DB.Model(&models.RomItem{}).Select("COALESCE(SUM(size_bytes), 0)").Scan(&totalBytes)

	cfg.TotalFilesCount = int(totalFiles)
	cfg.TotalSizeBytes = totalBytes
	cfg.TotalSizeFormatted = gdrive.FormatBytes(totalBytes)

	// Mask private key for security in response
	responseMap := fiber.Map{
		"id":                   cfg.ID,
		"folder_id":            cfg.FolderID,
		"folder_url":           cfg.FolderURL,
		"api_key":              cfg.APIKey,
		"has_service_account":  cfg.ServiceAccountJSON != "",
		"auth_type":            cfg.AuthType,
		"is_active":            cfg.IsActive,
		"last_synced_at":       cfg.LastSyncedAt,
		"total_files_count":    cfg.TotalFilesCount,
		"total_size_bytes":     cfg.TotalSizeBytes,
		"total_size_formatted": cfg.TotalSizeFormatted,
		"folder_name":          cfg.FolderName,
		"google_connected":     cfg.OAuthRefreshToken != "",
		"google_email":         cfg.OAuthEmail,
		"google_connected_at":  cfg.OAuthConnectedAt,
		"google_client_ready":  os.Getenv("GOOGLE_CLIENT_ID") != "" && os.Getenv("GOOGLE_CLIENT_SECRET") != "",
	}
	if romcache.Default != nil {
		responseMap["cache"] = romcache.Default.Status()
	}

	return c.JSON(responseMap)
}

type UpdateGDriveConfigRequest struct {
	FolderID           string `json:"folder_id"`
	FolderURL          string `json:"folder_url"`
	APIKey             string `json:"api_key"`
	ServiceAccountJSON string `json:"service_account_json"`
	AuthType           string `json:"auth_type"` // "api_key", "service_account", "public"
	IsActive           *bool  `json:"is_active"`
}

// AdminUpdateGDriveConfig saves Google Drive configuration
func AdminUpdateGDriveConfig(c *fiber.Ctx) error {
	var req UpdateGDriveConfigRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid configuration payload"})
	}

	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)

	if req.FolderID != "" {
		// Clean URL to folder ID if user pasted full google drive folder URL
		cleanedID := req.FolderID
		if strings.Contains(cleanedID, "folders/") {
			parts := strings.Split(cleanedID, "folders/")
			if len(parts) > 1 {
				cleanedID = strings.Split(parts[1], "?")[0]
			}
		}
		cfg.FolderID = strings.TrimSpace(cleanedID)
	}

	if req.FolderURL != "" {
		cfg.FolderURL = strings.TrimSpace(req.FolderURL)
	}
	if req.APIKey != "" {
		cfg.APIKey = strings.TrimSpace(req.APIKey)
	}
	if req.ServiceAccountJSON != "" {
		cfg.ServiceAccountJSON = strings.TrimSpace(req.ServiceAccountJSON)
	}
	if req.AuthType != "" {
		cfg.AuthType = req.AuthType
	}
	if req.IsActive != nil {
		cfg.IsActive = *req.IsActive
	}

	cfg.UpdatedAt = time.Now()
	if cfg.ID == 0 {
		database.DB.Create(&cfg)
	} else {
		database.DB.Save(&cfg)
	}

	return c.JSON(fiber.Map{
		"message":   "Google Drive configuration saved successfully",
		"folder_id": cfg.FolderID,
		"auth_type": cfg.AuthType,
	})
}

// AdminSyncGDrive triggers a scan of the Google Drive folder and syncs RomItem records
func AdminSyncGDrive(c *fiber.Ctx) error {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)

	// Google login connected: walk the console folders and refresh the SSD copy.
	if cfg.OAuthRefreshToken != "" && romcache.Default != nil {
		n, err := romcache.Default.SyncFromDrive(c.UserContext())
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": "Falha ao ler o Google Drive: " + err.Error()})
		}
		romcache.Default.Trigger(false)
		return c.JSON(fiber.Map{"message": "Biblioteca sincronizada", "items_synced": n, "cache": romcache.Default.Status()})
	}

	service := gdrive.NewDriveService(cfg)
	items, err := service.ScanFolder(cfg.FolderID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"message": fmt.Sprintf("Failed to scan Google Drive: %v", err),
		})
	}

	var totalBytes int64
	syncedCount := 0

	tx := database.DB.Begin()
	for _, item := range items {
		var existing models.RomItem
		if err := tx.Where("drive_file_id = ?", item.DriveFileID).First(&existing).Error; err != nil {
			// Create new
			if err := tx.Create(&item).Error; err == nil {
				syncedCount++
			}
		} else {
			// Update existing
			existing.Name = item.Name
			existing.Console = item.Console
			existing.Extension = item.Extension
			existing.SizeBytes = item.SizeBytes
			existing.SizeFormatted = item.SizeFormatted
			existing.DirectURL = item.DirectURL
			existing.DownloadURL = item.DownloadURL
			existing.IsAvailable = true
			existing.ModifiedAt = item.ModifiedAt
			tx.Save(&existing)
			syncedCount++
		}
		totalBytes += item.SizeBytes
	}
	tx.Commit()

	// Update sync metadata in GoogleDriveConfig
	now := time.Now()
	cfg.LastSyncedAt = &now
	cfg.TotalFilesCount = len(items)
	cfg.TotalSizeBytes = totalBytes
	cfg.TotalSizeFormatted = gdrive.FormatBytes(totalBytes)
	cfg.UpdatedAt = now
	database.DB.Save(&cfg)

	return c.JSON(fiber.Map{
		"message":              "Google Drive ROMs synchronized successfully",
		"items_synced":         syncedCount,
		"total_files":          cfg.TotalFilesCount,
		"total_size_formatted": cfg.TotalSizeFormatted,
		"last_synced_at":       cfg.LastSyncedAt,
	})
}

// AdminAddRom manually registers a ROM item
func AdminAddRom(c *fiber.Ctx) error {
	var item models.RomItem
	if err := c.BodyParser(&item); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid ROM payload"})
	}

	if item.DriveFileID == "" || item.Name == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "drive_file_id and name are required"})
	}

	if item.Console == "" {
		item.Console = gdrive.InferConsole(item.Name, item.FolderPath)
	}
	if item.Extension == "" {
		item.Extension = filepath.Ext(item.Name)
	}
	if item.SizeFormatted == "" && item.SizeBytes > 0 {
		item.SizeFormatted = gdrive.FormatBytes(item.SizeBytes)
	}
	item.DirectURL = gdrive.GenerateDirectDownloadURL(item.DriveFileID)
	item.DownloadURL = fmt.Sprintf("/api/roms/%s/download", item.DriveFileID)
	item.IsAvailable = true
	item.ModifiedAt = time.Now()

	if err := database.DB.Create(&item).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create ROM item"})
	}

	return c.Status(fiber.StatusCreated).JSON(item)
}

// AdminDeleteRom deletes a ROM item
func AdminDeleteRom(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := database.DB.Delete(&models.RomItem{}, id).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to delete ROM item"})
	}
	return c.JSON(fiber.Map{"message": "ROM deleted successfully"})
}

// SeedDefaultRoms populates starter ROMs into the database if empty
func SeedDefaultRoms() {
	var count int64
	database.DB.Model(&models.RomItem{}).Count(&count)
	if count > 0 {
		return
	}

	sampleItems := gdrive.GetSampleRomsCatalog("")
	for _, item := range sampleItems {
		database.DB.Create(&item)
	}

	var totalBytes int64
	for _, item := range sampleItems {
		totalBytes += item.SizeBytes
	}

	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	now := time.Now()
	cfg.TotalFilesCount = len(sampleItems)
	cfg.TotalSizeBytes = totalBytes
	cfg.TotalSizeFormatted = gdrive.FormatBytes(totalBytes)
	cfg.LastSyncedAt = &now
	if cfg.FolderID == "" {
		cfg.FolderID = "1gDrive_MemoryCard_ROMs_Vault"
	}
	if cfg.ID == 0 {
		database.DB.Create(&cfg)
	} else {
		database.DB.Save(&cfg)
	}
}
