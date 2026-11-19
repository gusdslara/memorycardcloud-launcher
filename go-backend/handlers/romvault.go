package handlers

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/diskusage"
	"go-backend/internal/gdrive"
	"go-backend/internal/romcache"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// --- Private ROM library: Google login of the superadmin, folder choice, SSD cache, who has access ---

func adminUserID(c *fiber.Ctx) uint {
	if tok, ok := c.Locals("user").(*jwt.Token); ok && tok != nil {
		if claims, ok := tok.Claims.(jwt.MapClaims); ok {
			if f, ok := claims["sub"].(float64); ok {
				return uint(f)
			}
		}
	}
	return 0
}

// oauthRedirectURL must match an "Authorized redirect URI" of the Google OAuth client.
func oauthRedirectURL(c *fiber.Ctx) string {
	if u := strings.TrimSpace(os.Getenv("GOOGLE_REDIRECT_URL")); u != "" {
		return u
	}
	if base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"); base != "" {
		return base + "/api/gdrive/oauth/callback"
	}
	return c.BaseURL() + "/api/gdrive/oauth/callback"
}

// siteURL is where the admin page lives (same origin by default).
func siteURL(path string) string {
	return strings.TrimRight(os.Getenv("SITE_URL"), "/") + path
}

func signOAuthState(userID uint) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": userID,
		"pur": "gdrive-oauth",
		"exp": time.Now().Add(10 * time.Minute).Unix(),
	}).SignedString([]byte(os.Getenv("JWT_SECRET")))
}

func verifyOAuthState(state string) (uint, error) {
	tok, err := jwt.Parse(state, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("método inesperado")
		}
		return []byte(os.Getenv("JWT_SECRET")), nil
	})
	if err != nil || !tok.Valid {
		return 0, fmt.Errorf("link de login expirado, tente de novo")
	}
	claims := tok.Claims.(jwt.MapClaims)
	if claims["pur"] != "gdrive-oauth" {
		return 0, fmt.Errorf("state inválido")
	}
	f, _ := claims["sub"].(float64)
	return uint(f), nil
}

// AdminGDriveOAuthURL → {url}: the admin page sends the browser there ("Entrar com Google").
func AdminGDriveOAuthURL(c *fiber.Ctx) error {
	o, err := gdrive.OAuthFromEnv(oauthRedirectURL(c))
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	state, err := signOAuthState(adminUserID(c))
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Falha ao iniciar login"})
	}
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	return c.JSON(fiber.Map{"url": o.AuthCodeURL(state, cfg.OAuthEmail), "redirect_uri": o.RedirectURL})
}

// GDriveOAuthCallback is hit by Google after the superadmin logs in (public route, validated by state).
func GDriveOAuthCallback(c *fiber.Ctx) error {
	back := func(status, msg string) error {
		q := url.Values{"google": {status}}
		if msg != "" {
			q.Set("msg", msg)
		}
		return c.Redirect(siteURL("/admin/?"+q.Encode()), fiber.StatusFound)
	}
	if e := c.Query("error"); e != "" {
		return back("erro", "Login cancelado no Google ("+e+")")
	}
	uid, err := verifyOAuthState(c.Query("state"))
	if err != nil {
		return back("erro", err.Error())
	}
	var admin models.User
	if err := database.DB.First(&admin, uid).Error; err != nil || !admin.IsAdmin {
		return back("erro", "Só o superadmin pode conectar o Google Drive")
	}
	o, err := gdrive.OAuthFromEnv(oauthRedirectURL(c))
	if err != nil {
		return back("erro", err.Error())
	}
	refresh, _, email, err := o.Exchange(c.UserContext(), c.Query("code"))
	if err != nil {
		return back("erro", err.Error())
	}

	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	old := cfg.OAuthRefreshToken
	now := time.Now()
	cfg.OAuthRefreshToken, cfg.OAuthEmail, cfg.OAuthConnectedAt = refresh, email, &now
	cfg.AuthType, cfg.IsActive, cfg.UpdatedAt = "oauth", true, now
	if cfg.ID == 0 {
		database.DB.Create(&cfg)
	} else {
		database.DB.Save(&cfg)
	}
	if old != "" && old != refresh {
		go gdrive.Revoke(old)
	}
	if cfg.FolderID != "" && romcache.Default != nil {
		romcache.Default.Trigger(true)
	}
	return back("conectado", email)
}

// AdminGDriveDisconnect forgets (and revokes) the Google login. The SSD copy stays.
func AdminGDriveDisconnect(c *fiber.Ctx) error {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	go gdrive.Revoke(cfg.OAuthRefreshToken)
	cfg.OAuthRefreshToken, cfg.OAuthEmail, cfg.OAuthConnectedAt = "", "", nil
	cfg.AuthType, cfg.UpdatedAt = "api_key", time.Now()
	if cfg.ID != 0 {
		database.DB.Save(&cfg)
	}
	return c.JSON(fiber.Map{"message": "Google Drive desconectado"})
}

func connectedDrive(c *fiber.Ctx) (*gdrive.DriveService, *models.GoogleDriveConfig, error) {
	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	if cfg.OAuthRefreshToken == "" {
		return nil, nil, fmt.Errorf("conecte o Google Drive primeiro")
	}
	return gdrive.NewDriveService(cfg), &cfg, nil
}

// AdminGDriveFolders lists folders: ?parent=<id|root> or ?q=<name> (search anywhere).
func AdminGDriveFolders(c *fiber.Ctx) error {
	svc, _, err := connectedDrive(c)
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	folders, err := svc.ListFolders(c.UserContext(), c.Query("parent", "root"), c.Query("q"))
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": err.Error()})
	}
	return c.JSON(fiber.Map{"folders": folders})
}

// AdminGDriveSetFolder {folder_id}: chooses the "roms" folder and starts the first sync.
func AdminGDriveSetFolder(c *fiber.Ctx) error {
	var req struct {
		FolderID   string `json:"folder_id"`
		FolderPath string `json:"folder_path"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.FolderID) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "folder_id obrigatório"})
	}
	id := strings.TrimSpace(req.FolderID)
	if i := strings.Index(id, "folders/"); i >= 0 { // pasted a Drive URL
		id = strings.SplitN(id[i+len("folders/"):], "?", 2)[0]
	}
	svc, cfg, err := connectedDrive(c)
	if err != nil {
		return c.Status(fiber.StatusPreconditionFailed).JSON(fiber.Map{"message": err.Error()})
	}
	name, err := svc.FolderName(c.UserContext(), id)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	// The main folder is an automatic library folder (each sub-folder a console). Choosing another
	// one replaces the previous automatic main folder; folders mapped to a console stay.
	if cfg.FolderID != "" && cfg.FolderID != id {
		database.DB.Where("folder_id = ? AND (console = '' OR console IS NULL)", cfg.FolderID).Delete(&models.RomSource{})
	}
	var src models.RomSource
	database.DB.Where("folder_id = ?", id).First(&src)
	src.FolderID, src.FolderName = id, name
	if p := strings.TrimSpace(req.FolderPath); p != "" {
		src.FolderPath = p
	} else if src.FolderPath == "" {
		src.FolderPath = name
	}
	src.Console = ""
	if src.Layout == "" {
		src.Layout = gdrive.LayoutAuto
	}
	if src.ID == 0 {
		database.DB.Create(&src)
	} else {
		database.DB.Save(&src)
	}
	cfg.FolderID, cfg.FolderName, cfg.UpdatedAt = id, name, time.Now()
	database.DB.Save(cfg)
	if romcache.Default != nil {
		romcache.Default.Trigger(true)
	}
	return c.JSON(fiber.Map{"message": "Pasta escolhida", "folder_id": id, "folder_name": name, "source": src})
}

// AdminRomsCacheStatus: progress of the SSD copy + per-console totals.
func AdminRomsCacheStatus(c *fiber.Ctx) error {
	type row struct {
		Console string `json:"console"`
		Files   int64  `json:"files"`
		Bytes   int64  `json:"bytes"`
		Cached  int64  `json:"cached"`
	}
	var rows []row
	database.DB.Model(&models.RomItem{}).Where("is_available = ?", true).
		Select("console, COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes, SUM(CASE WHEN cache_status = 'cached' THEN 1 ELSE 0 END) AS cached").
		Group("console").Order("console").Scan(&rows)
	out := fiber.Map{"consoles": rows}
	if romcache.Default != nil {
		out["cache"] = romcache.Default.Status()
	}
	return c.JSON(out)
}

// AdminRomsCacheRun {sync?: bool}: starts a pass now.
func AdminRomsCacheRun(c *fiber.Ctx) error {
	if romcache.Default == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": "cache desativado"})
	}
	var req struct {
		Sync bool `json:"sync"`
	}
	_ = c.BodyParser(&req)
	romcache.Default.Trigger(req.Sync)
	return c.JSON(fiber.Map{"message": "Cópia para o SSD iniciada", "cache": romcache.Default.Status()})
}

// AdminRomsAccessList: accounts that can use the private library (besides superadmins).
func AdminRomsAccessList(c *fiber.Ctx) error {
	var users []models.User
	database.DB.Where("roms_access = ? OR is_admin = ?", true, true).Order("is_admin DESC, email").Find(&users)
	out := make([]fiber.Map, 0, len(users))
	for _, u := range users {
		out = append(out, fiber.Map{"id": u.ID, "email": u.Email, "name": u.Name, "is_admin": u.IsAdmin, "roms_access": u.RomsAccess, "subscription_plan": u.SubscriptionPlan})
	}
	return c.JSON(fiber.Map{"users": out})
}

// AdminSetRomsAccess {enabled, email?}: grants/revokes the private library (and the secret Diamond plan).
// Target is :id, or the account with the given e-mail when :id is "email".
func AdminSetRomsAccess(c *fiber.Ctx) error {
	var req struct {
		Enabled bool   `json:"enabled"`
		Email   string `json:"email"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Pedido inválido"})
	}
	var user models.User
	q := database.DB
	if c.Params("id") == "email" {
		q = q.Where("LOWER(email) = ?", strings.ToLower(strings.TrimSpace(req.Email)))
	} else {
		q = q.Where("id = ?", c.Params("id"))
	}
	if err := q.First(&user).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Conta não encontrada. A pessoa precisa criar a conta antes."})
	}
	applyFamilyAccess(&user, req.Enabled)
	database.DB.Save(&user)
	return c.JSON(fiber.Map{"id": user.ID, "email": user.Email, "roms_access": user.RomsAccess, "subscription_plan": user.SubscriptionPlan})
}

// applyFamilyAccess turns the family feature (private ROM library) on or off. On: the secret
// Diamond plan, active and without expiry (Exclusive stays). Off: leaves Diamond for no plan.
func applyFamilyAccess(user *models.User, enabled bool) {
	user.RomsAccess = enabled
	if enabled {
		if !strings.EqualFold(user.SubscriptionPlan, "exclusive") {
			user.SubscriptionPlan = "diamond"
			user.SubscriptionStatus = "active"
			user.SubscriptionExpiresAt = nil
			user.StorageLimit = models.GetPlanStorageLimit("diamond")
		}
	} else if strings.EqualFold(user.SubscriptionPlan, "diamond") {
		user.SubscriptionPlan = "none"
		user.SubscriptionStatus = "inactive"
		user.SubscriptionExpiresAt = nil
		user.StorageLimit = models.GetPlanStorageLimit("free")
	}
}

// AdminStorage: real disk space of the server, Google Drive quota of the connected account,
// and how much the users' cloud saves take.
func AdminStorage(c *fiber.Ctx) error {
	type disk struct {
		Label string `json:"label"`
		Path  string `json:"path"`
		Total uint64 `json:"total"`
		Used  uint64 `json:"used"`
		Free  uint64 `json:"free"`
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	places := []struct{ label, path string }{
		{"Saves dos usuários", "./uploads"},
		{"Banco e catálogo", dataDir},
	}
	if romcache.Default != nil {
		places = append([]struct{ label, path string }{{"Biblioteca de ROMs (SSD)", romcache.Default.Dir()}}, places...)
	}
	var disks []disk
	for _, p := range places {
		u, err := diskusage.Of(p.path)
		if err != nil {
			continue
		}
		merged := false
		for i := range disks { // same filesystem → one bar with both labels
			if disks[i].Total == u.Total && disks[i].Free == u.Free {
				disks[i].Label += " + " + p.label
				merged = true
				break
			}
		}
		if !merged {
			disks = append(disks, disk{Label: p.label, Path: u.Path, Total: u.Total, Used: u.Used, Free: u.Free})
		}
	}

	var saves struct {
		Files int64 `json:"files"`
		Bytes int64 `json:"bytes"`
		Users int64 `json:"users"`
	}
	database.DB.Model(&models.GameSave{}).Count(&saves.Files)
	database.DB.Model(&models.GameSave{}).Select("COALESCE(SUM(size),0)").Scan(&saves.Bytes)
	database.DB.Model(&models.GameSave{}).Distinct("user_id").Count(&saves.Users)

	var cfg models.GoogleDriveConfig
	database.DB.First(&cfg)
	drive := fiber.Map{
		"connected":    cfg.OAuthRefreshToken != "",
		"email":        cfg.OAuthEmail,
		"client_ready": os.Getenv("GOOGLE_CLIENT_ID") != "" && os.Getenv("GOOGLE_CLIENT_SECRET") != "",
		"folder_name":  cfg.FolderName,
	}
	if cfg.OAuthRefreshToken != "" {
		if q, err := gdrive.NewDriveService(cfg).StorageQuota(c.UserContext()); err == nil {
			drive["quota"] = q
		} else {
			drive["error"] = err.Error()
		}
	}

	out := fiber.Map{"disks": disks, "saves": saves, "drive": drive}
	if romcache.Default != nil {
		out["library"] = romcache.Default.Status()
	}
	return c.JSON(out)
}
