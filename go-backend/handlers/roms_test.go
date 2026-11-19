package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/internal/romcache"
	"go-backend/models"

	"github.com/glebarez/sqlite"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

func setupRomsTestDB(t *testing.T) {
	os.Setenv("JWT_SECRET", "testsecret1234567890123456789012")
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("Failed to connect to test in-memory db: %v", err)
	}
	database.DB = db

	// Register dynamic PlanStorageResolver
	models.PlanStorageResolver = func(tier string) int64 {
		if database.DB == nil {
			return 0
		}
		var plan models.Plan
		if err := database.DB.Select("storage_limit_bytes").Where("LOWER(tier) = LOWER(?)", tier).First(&plan).Error; err == nil && plan.StorageLimitBytes > 0 {
			return plan.StorageLimitBytes
		}
		return 0
	}

	err = db.AutoMigrate(
		&models.User{},
		&models.Plan{},
		&models.GoogleDriveConfig{},
		&models.RomItem{},
		&models.RomSource{},
	)
	if err != nil {
		t.Fatalf("Failed to automigrate: %v", err)
	}

	SeedDefaultPlans()
	SeedDefaultRoms()
}

func createRomTestToken(userId uint) string {
	claims := jwt.MapClaims{
		"sub": userId,
		"exp": time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	str, _ := token.SignedString([]byte(os.Getenv("JWT_SECRET")))
	return str
}

func TestPlanManagementAndStorageLimits(t *testing.T) {
	setupRomsTestDB(t)

	app := fiber.New()
	app.Get("/api/plans", GetPlans)
	adminGroup := app.Group("/api/admin", AuthMiddleware(), AdminMiddleware)
	adminGroup.Get("/plans", AdminGetPlans)
	adminGroup.Post("/plans", AdminCreatePlan)
	adminGroup.Put("/plans/:tier", AdminUpdatePlan)
	adminGroup.Delete("/plans/:tier", AdminDeletePlan)

	admin := models.User{
		Email:   "superadmin@memorycard.cloud",
		IsAdmin: true,
	}
	database.DB.Create(&admin)
	adminToken := createRomTestToken(admin.ID)

	// 1. Verify Public /api/plans hides secret plans by default
	reqPublic := httptest.NewRequest("GET", "/api/plans", nil)
	respPublic, _ := app.Test(reqPublic)
	if respPublic.StatusCode != 200 {
		t.Fatalf("Expected 200 from GET /api/plans, got %d", respPublic.StatusCode)
	}
	var publicPlans []models.Plan
	json.NewDecoder(respPublic.Body).Decode(&publicPlans)

	for _, p := range publicPlans {
		if p.IsSecret {
			t.Errorf("Secret plan '%s' should NOT be visible on public /api/plans", p.Tier)
		}
	}

	// 2. Superadmin creates a new Secret Plan Tier with 1TB drive space and ROMs access
	const TB = 1024 * 1024 * 1024 * 1024
	newPlan := models.Plan{
		Tier:              "retro_god_vault",
		Name:              "Retro God Secret Vault",
		Description:       "Superadmin exclusive tier with 1TB cloud save storage and unlimited ROMs downloads.",
		MonthlyPrice:      199.00,
		YearlyPrice:       1990.00,
		StorageLimitBytes: 1 * TB,
		StorageDisplay:    "1 TB",
		HasRomsAccess:     true,
		IsSecret:          true,
	}
	bodyJSON, _ := json.Marshal(newPlan)
	reqCreate := httptest.NewRequest("POST", "/api/admin/plans", bytes.NewBuffer(bodyJSON))
	reqCreate.Header.Set("Authorization", "Bearer "+adminToken)
	reqCreate.Header.Set("Content-Type", "application/json")
	respCreate, _ := app.Test(reqCreate)

	if respCreate.StatusCode != 201 {
		t.Fatalf("Expected 201 Created from AdminCreatePlan, got %d", respCreate.StatusCode)
	}

	// 3. Verify dynamic storage resolver resolves 1TB for this new tier
	resolvedLimit := models.GetPlanStorageLimit("retro_god_vault")
	if resolvedLimit != 1*TB {
		t.Errorf("Expected dynamically resolved limit to be 1 TB (%d), got %d", 1*TB, resolvedLimit)
	}

	// 4. Update the plan's storage limit to 2TB
	updatePayload := map[string]interface{}{
		"storage_limit_bytes": 2 * TB,
		"storage_display":     "2 TB",
		"has_roms_access":     true,
		"is_secret":           true,
	}
	updateJSON, _ := json.Marshal(updatePayload)
	reqUpdate := httptest.NewRequest("PUT", "/api/admin/plans/retro_god_vault", bytes.NewBuffer(updateJSON))
	reqUpdate.Header.Set("Authorization", "Bearer "+adminToken)
	reqUpdate.Header.Set("Content-Type", "application/json")
	respUpdate, _ := app.Test(reqUpdate)

	if respUpdate.StatusCode != 200 {
		t.Fatalf("Expected 200 from AdminUpdatePlan, got %d", respUpdate.StatusCode)
	}

	// Dynamic storage check should now be 2TB
	if models.GetPlanStorageLimit("retro_god_vault") != 2*TB {
		t.Errorf("Expected updated storage limit to be 2 TB, got %d", models.GetPlanStorageLimit("retro_god_vault"))
	}

	// 5. Admin can list all plans including secret tiers
	reqAdminList := httptest.NewRequest("GET", "/api/admin/plans", nil)
	reqAdminList.Header.Set("Authorization", "Bearer "+adminToken)
	respAdminList, _ := app.Test(reqAdminList)
	var allPlans []models.Plan
	json.NewDecoder(respAdminList.Body).Decode(&allPlans)

	foundSecret := false
	for _, p := range allPlans {
		if p.Tier == "retro_god_vault" && p.IsSecret && p.HasRomsAccess {
			foundSecret = true
			break
		}
	}
	if !foundSecret {
		t.Errorf("Expected retro_god_vault to be listed in admin plans")
	}

	// 6. Delete plan
	reqDel := httptest.NewRequest("DELETE", "/api/admin/plans/retro_god_vault", nil)
	reqDel.Header.Set("Authorization", "Bearer "+adminToken)
	respDel, _ := app.Test(reqDel)
	if respDel.StatusCode != 200 {
		t.Fatalf("Expected 200 from AdminDeletePlan, got %d", respDel.StatusCode)
	}
}

func TestRomsAccessGating(t *testing.T) {
	setupRomsTestDB(t)

	app := fiber.New()
	app.Get("/api/roms", AuthMiddleware(), RequireRomsAccessMiddleware, GetRoms)
	app.Get("/api/roms/:id/direct-link", AuthMiddleware(), RequireRomsAccessMiddleware, GetRomDirectLink)

	mk := func(u models.User) string {
		database.DB.Create(&u)
		return createRomTestToken(u.ID)
	}
	// The library is private: no plan unlocks it, only the superadmin's grant.
	silverToken := mk(models.User{Email: "silver@example.com", SubscriptionStatus: "active", SubscriptionPlan: "silver"})
	paidDiamondToken := mk(models.User{Email: "diamond@example.com", SubscriptionStatus: "active", SubscriptionPlan: "diamond"})
	exclusiveToken := mk(models.User{Email: "secret@example.com", SubscriptionStatus: "active", SubscriptionPlan: "exclusive"})
	grantedToken := mk(models.User{Email: "esposa@example.com", RomsAccess: true})
	adminToken := mk(models.User{Email: "boss@memorycard.cloud", IsAdmin: true})

	get := func(path, token string) int {
		req := httptest.NewRequest("GET", path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, _ := app.Test(req)
		return resp.StatusCode
	}

	if got := get("/api/roms", ""); got != 401 {
		t.Errorf("unauthenticated: want 401, got %d", got)
	}
	for name, tok := range map[string]string{"silver": silverToken, "paid diamond": paidDiamondToken, "exclusive plan": exclusiveToken} {
		if got := get("/api/roms", tok); got != 403 {
			t.Errorf("%s without grant: want 403, got %d", name, got)
		}
	}
	for name, tok := range map[string]string{"granted": grantedToken, "superadmin": adminToken} {
		if got := get("/api/roms", tok); got != 200 {
			t.Errorf("%s: want 200, got %d", name, got)
		}
	}
	if got := get("/api/roms/1gDrive_PS2_GodOfWar2/direct-link", grantedToken); got != 200 {
		t.Errorf("direct-link for granted user: want 200, got %d", got)
	}
}

func TestAdminGrantsAndRevokesRomsAccess(t *testing.T) {
	setupRomsTestDB(t)
	app := fiber.New()
	app.Put("/api/admin/users/:id/roms-access", AdminSetRomsAccess)

	wife := models.User{Email: "Esposa@Example.com", SubscriptionPlan: "none", SubscriptionStatus: "inactive"}
	database.DB.Create(&wife)

	put := func(id, body string) int {
		req := httptest.NewRequest("PUT", "/api/admin/users/"+id+"/roms-access", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		return resp.StatusCode
	}
	if got := put("email", `{"enabled":true,"email":"esposa@example.com"}`); got != 200 {
		t.Fatalf("grant by e-mail: want 200, got %d", got)
	}
	database.DB.First(&wife, wife.ID)
	if !wife.RomsAccess || wife.SubscriptionPlan != "diamond" || wife.SubscriptionStatus != "active" {
		t.Fatalf("grant should enable the library and the secret Diamond plan, got %+v", wife)
	}
	if got := put("email", `{"enabled":true,"email":"ninguem@example.com"}`); got != 404 {
		t.Errorf("unknown e-mail: want 404, got %d", got)
	}
	if got := put(strconv.Itoa(int(wife.ID)), `{"enabled":false}`); got != 200 {
		t.Fatalf("revoke: want 200, got %d", got)
	}
	database.DB.First(&wife, wife.ID)
	if wife.RomsAccess || wife.SubscriptionPlan != "none" {
		t.Fatalf("revoke should remove access and the Diamond plan, got %+v", wife)
	}
}

// The storefront (owner, 2026-11): silver R$ 15 / 5 GB, gold R$ 30 / 30 GB, diamond R$ 50 / 100 GB,
// yearly = 10x monthly. Diamond is now sold; the private library still needs the superadmin's grant
// (see TestRomsAccessGating: a paid diamond gets 403).
func TestStorefrontPlans(t *testing.T) {
	setupRomsTestDB(t)
	const gb = int64(1024 * 1024 * 1024)
	want := map[string]struct {
		monthly, yearly float64
		bytes           int64
	}{"silver": {15, 150, 5 * gb}, "gold": {30, 300, 30 * gb}, "diamond": {50, 500, 100 * gb}}
	for tier, w := range want {
		var p models.Plan
		database.DB.Where("tier = ?", tier).First(&p)
		if p.IsSecret || p.MonthlyPrice != w.monthly || p.YearlyPrice != w.yearly || p.StorageLimitBytes != w.bytes {
			t.Errorf("%s: %+v", tier, p)
		}
		if models.GetPlanStorageLimit(tier) != w.bytes {
			t.Errorf("%s storage limit: %d", tier, models.GetPlanStorageLimit(tier))
		}
	}
}

func TestConsoleInferenceAndDirectURL(t *testing.T) {
	// 1. Direct URL generator should bypass Google Drive HTML warning
	fileID := "1AbC_XyZ_98765"
	directURL := gdrive.GenerateDirectDownloadURL(fileID)
	if !strings.Contains(directURL, fileID) || !strings.Contains(directURL, "confirm=t") {
		t.Errorf("Expected confirm=t in direct URL, got %s", directURL)
	}

	ucURL := gdrive.GenerateUcURL(fileID)
	if !strings.Contains(ucURL, "drive.google.com/uc") || !strings.Contains(ucURL, "confirm=t") {
		t.Errorf("Expected uc URL with confirm=t, got %s", ucURL)
	}

	// 2. Console Heuristics
	tests := []struct {
		filename    string
		folder      string
		wantConsole string
	}{
		{"God of War.iso", "PS2", "PS2"},
		{"Zelda Tears.nsp", "", "Switch"},
		{"Pokemon Scarlet.xci", "", "Switch"},
		{"Super Smash Melee.rvz", "", "GameCube"},
		{"Mario Kart Wii.wbfs", "", "Wii"},
		{"Castlevania SOTN.chd", "", "PS1"},
		{"Crisis Core.cso", "", "PSP"},
		{"Super Mario 64.z64", "", "N64"},
		{"Chrono Trigger.sfc", "", "SNES"},
		{"Pokemon Emerald.gba", "", "GBA"},
		{"scph39001.bin", "", "BIOS"},
		{"ps2_bios.zip", "", "BIOS"},
	}

	for _, tc := range tests {
		got := gdrive.InferConsole(tc.filename, tc.folder)
		if got != tc.wantConsole {
			t.Errorf("InferConsole(%q, %q) = %q, want %q", tc.filename, tc.folder, got, tc.wantConsole)
		}
	}

	// 3. FormatBytes
	if gdrive.FormatBytes(1024*1024*1024*4) != "4.00 GB" {
		t.Errorf("Expected 4.00 GB, got %s", gdrive.FormatBytes(1024*1024*1024*4))
	}
}

func TestDownloadServesSSDCopy(t *testing.T) {
	setupRomsTestDB(t)
	dir := t.TempDir()
	t.Setenv("ROMS_CACHE_DIR", dir)
	romcache.Default = romcache.FromEnv()
	t.Cleanup(func() { romcache.Default = nil })

	local := dir + "/mm.z64"
	os.WriteFile(local, []byte("Z64DATA"), 0o644)
	rom := models.RomItem{DriveFileID: "mm", Name: "Zelda MM (USA).z64", Console: "N64", SizeBytes: 7, IsAvailable: true, LocalPath: local, CacheStatus: "cached"}
	database.DB.Create(&rom)
	admin := models.User{Email: "boss@x", IsAdmin: true}
	database.DB.Create(&admin)

	app := fiber.New()
	app.Get("/api/roms/:id/download", AuthMiddleware(), RequireRomsAccessMiddleware, DownloadRom)
	req := httptest.NewRequest("GET", "/api/roms/mm/download?token="+createRomTestToken(admin.ID), nil)
	resp, _ := app.Test(req)
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "Z64DATA" {
		t.Fatalf("want SSD copy, got %d %q", resp.StatusCode, body)
	}
	if !strings.Contains(resp.Header.Get("Content-Disposition"), "Zelda") {
		t.Errorf("download name: %s", resp.Header.Get("Content-Disposition"))
	}
}

func TestAdminStorageReportsDisksAndSaves(t *testing.T) {
	setupRomsTestDB(t)
	database.DB.AutoMigrate(&models.GameSave{})
	t.Setenv("DATA_DIR", t.TempDir())
	database.DB.Create(&models.GameSave{UserID: 1, GameName: "Zelda", Size: 1000})
	database.DB.Create(&models.GameSave{UserID: 2, GameName: "Mario", Size: 500})

	app := fiber.New()
	app.Get("/api/admin/storage", AdminStorage)
	resp, _ := app.Test(httptest.NewRequest("GET", "/api/admin/storage", nil))
	var out struct {
		Disks []struct {
			Label string `json:"label"`
			Total uint64 `json:"total"`
		} `json:"disks"`
		Saves struct {
			Files int64 `json:"files"`
			Bytes int64 `json:"bytes"`
			Users int64 `json:"users"`
		} `json:"saves"`
		Drive map[string]any `json:"drive"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if len(out.Disks) == 0 || out.Disks[0].Total == 0 {
		t.Fatalf("server disks missing: %+v", out.Disks)
	}
	if out.Saves.Files != 2 || out.Saves.Bytes != 1500 || out.Saves.Users != 2 {
		t.Fatalf("saves totals: %+v", out.Saves)
	}
	if out.Drive["connected"] != false {
		t.Fatalf("drive should be disconnected: %+v", out.Drive)
	}
}

func TestGamesGroupingAndUserPicker(t *testing.T) {
	setupRomsTestDB(t)
	database.DB.Where("1 = 1").Delete(&models.RomItem{})
	for _, r := range []models.RomItem{
		{DriveFileID: "c1", Name: "Spyro.cue", Console: "PS1", SizeBytes: 1, GameKey: "1:PS1/Spyro", GameTitle: "Spyro", GameFolder: true, GameParts: 2, GameMain: true, GamePath: "Spyro.cue", IsAvailable: true},
		{DriveFileID: "c2", Name: "Track 01.bin", Console: "PS1", SizeBytes: 9, GameKey: "1:PS1/Spyro", GameTitle: "Spyro", GameFolder: true, GameParts: 2, GamePath: "Track 01.bin", IsAvailable: true},
		{DriveFileID: "g1", Name: "God of War.iso", Console: "PS2", SizeBytes: 5, IsAvailable: true}, // synced before games existed
	} {
		database.DB.Create(&r)
	}
	admin := models.User{Email: "boss@memorycard.cloud", Name: "Nathan", IsAdmin: true}
	database.DB.Create(&admin)
	database.DB.Create(&models.User{Email: "esposa@example.com", Name: "Esposa"})
	database.DB.Create(&models.User{Email: "outro@example.com"})
	token := createRomTestToken(admin.ID)

	app := fiber.New()
	app.Get("/api/roms", AuthMiddleware(), RequireRomsAccessMiddleware, GetRoms)
	app.Get("/api/admin/roms/users", AuthMiddleware(), AdminMiddleware, AdminRomsUsers)
	get := func(path string, out any) int {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, _ := app.Test(req)
		json.NewDecoder(resp.Body).Decode(out)
		return resp.StatusCode
	}

	var body struct {
		Games []RomGame `json:"games"`
		Total int64     `json:"total"`
	}
	if code := get("/api/roms?group=games&limit=10", &body); code != 200 || body.Total != 2 || len(body.Games) != 2 {
		t.Fatalf("games: %d %+v", code, body)
	}
	gow, spyro := body.Games[0], body.Games[1]
	if gow.Title != "God of War" || gow.Parts != 1 || spyro.Title != "Spyro" || spyro.Parts != 2 || !spyro.Folder || spyro.Main != "Spyro.cue" || spyro.SizeBytes != 10 {
		t.Fatalf("grouped games: %+v / %+v", gow, spyro)
	}
	if code := get("/api/roms?group=games&q=spyro", &body); code != 200 || body.Total != 1 || len(body.Games[0].Files) != 2 {
		t.Fatalf("search keeps whole games: %+v", body)
	}

	var users struct {
		Users []map[string]any `json:"users"`
		Total int64            `json:"total"`
	}
	if code := get("/api/admin/roms/users", &users); code != 200 || users.Total != 3 || users.Users[0]["email"] != "boss@memorycard.cloud" {
		t.Fatalf("user picker lists every account, superadmin first: %+v", users)
	}
	if code := get("/api/admin/roms/users?q=espo", &users); code != 200 || users.Total != 1 || users.Users[0]["name"] != "Esposa" {
		t.Fatalf("search by name/e-mail: %+v", users)
	}
}
