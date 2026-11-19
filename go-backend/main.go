package main

import (
	"context"
	"fmt"
	"go-backend/database"
	"go-backend/handlers"
	"go-backend/internal/romcache"
	"go-backend/models"
	"os"

	"github.com/gofiber/fiber/v2"
	fiberLogger "github.com/gofiber/fiber/v2/middleware/logger"
	fiberRecover "github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		// Just log, don't crash, because maybe env vars are set by system
		// log.Println("No .env file found")
	}

	// STARTUP LOGS (Request ID 787)
	fmt.Println("----------------------------------------------------------------")
	fmt.Printf("[STARTUP] Admin Email: %s\n", os.Getenv("ADMIN_EMAIL"))
	if os.Getenv("ADMIN_PASSWORD") != "" {
		fmt.Println("[STARTUP] Admin Password: [SET]")
	} else {
		fmt.Println("[STARTUP] Admin Password: [NOT SET]")
	}
	fmt.Println("----------------------------------------------------------------")

	database.Connect()
	database.DB.AutoMigrate(
		&models.User{},
		&models.GameSave{},
		&models.Plan{},
		&models.Game{},
		&models.RefreshToken{},
		&models.GoogleDriveConfig{},
		&models.RomItem{},
		&models.RomSource{},
		&models.NativeGame{},
		&models.NativeBuild{},
		&models.AppRelease{},
		&models.PortReview{},
		&models.ReviewImportState{},
		&models.PortSubmission{},
	)
	database.SeedAdmin()
	handlers.SeedDefaultPlans()
	handlers.SeedDefaultRoms()

	// SSD copy of the private ROM library (Google Drive is the source)
	romcache.Default = romcache.FromEnv()
	go romcache.Default.Run(context.Background())

	// Player reviews: import public reports from RecompLauncher (REVIEWS_IMPORT=false disables)
	handlers.StartReviewImporter(context.Background())

	app := fiber.New(fiber.Config{
		BodyLimit: 500 * 1024 * 1024, // 500MB
	})

	app.Static("/uploads", "./uploads") // Serve uploads directory

	app.Use(fiberLogger.New()) // Add Logger to see incoming requests
	// Open data (catalog, ports, reviews) for any site; the rest only for the site + the Tauri webview.
	// CORS_ORIGINS adds origins to the defaults (handlers.DefaultCORSOrigins), it no longer replaces them.
	app.Use(handlers.CORS())

	// Health Check (when the landing page is not served by this process)
	landingDir := os.Getenv("LANDING_DIR")
	if landingDir == "" {
		app.Get("/", func(c *fiber.Ctx) error {
			return c.SendString("API is Running")
		})
	}
	app.Get("/api/health", func(c *fiber.Ctx) error {
		return c.SendStatus(200)
	})

	app.Use(fiberRecover.New())

	app.Post("/api/register", handlers.Register)
	app.Post("/api/login", handlers.Login)
	app.Post("/api/refresh", handlers.Refresh) // New: Refresh Token
	app.Post("/api/logout", handlers.Logout)   // New: Logout
	app.Get("/api/user", handlers.Me)
	app.Get("/api/me", handlers.Me)                      // Alias for Desktop App compatibility
	app.Put("/api/user/profile", handlers.UpdateProfile) // Profile Update

	// Desktop App API
	app.Post("/api/check-version", handlers.CheckVersion)
	app.Post("/api/upload", handlers.UploadBackup)
	app.Post("/api/upload/backup", handlers.UploadBackup) // Alias for Desktop App

	// Game Covers
	app.Post("/api/games/cover", handlers.UploadCover)

	app.Get("/api/saves", handlers.GetSaves)
	app.Post("/api/saves", handlers.UploadSave) // Web Upload
	app.Get("/api/saves/:id/download", handlers.DownloadSave)
	app.Delete("/api/saves/:id", handlers.DeleteSave)

	app.Get("/api/subscription", handlers.GetSubscription)
	app.Post("/api/subscription", handlers.Subscribe)
	app.Get("/api/events", handlers.StreamEvents) // SSE Endpoint
	app.Post("/api/webhooks/asaas", handlers.HandleAsaasWebhook)

	// One-time purchases: "Sem anúncios para sempre" (R$ 10, removes the ads from the app forever)
	app.Get("/api/purchases/ad-free", handlers.GetAdFreeOffer)
	app.Post("/api/purchases/ad-free", handlers.AuthMiddleware(), handlers.PurchaseAdFree)

	// Plan Management
	app.Get("/api/plans", handlers.GetPlans)

	// Google login of the superadmin (Drive "roms" folder). Public route, protected by the signed state.
	app.Get("/api/gdrive/oauth/callback", handlers.GDriveOAuthCallback)

	// Private ROM library (superadmin + accounts granted by the superadmin), served from the SSD copy
	app.Get("/api/roms", handlers.AuthMiddleware(), handlers.RequireRomsAccessMiddleware, handlers.GetRoms)
	app.Get("/api/roms/:id/download", handlers.AuthMiddleware(), handlers.RequireRomsAccessMiddleware, handlers.DownloadRom)
	app.Get("/api/roms/:id/direct-link", handlers.AuthMiddleware(), handlers.RequireRomsAccessMiddleware, handlers.GetRomDirectLink)

	// Admin User Management, Plans & Google Drive
	adminGroup := app.Group("/api/admin", handlers.AuthMiddleware(), handlers.AdminMiddleware)
	adminGroup.Get("/plans", handlers.AdminGetPlans)
	adminGroup.Post("/plans", handlers.AdminCreatePlan)
	adminGroup.Put("/plans", handlers.UpdatePlans)
	adminGroup.Put("/plans/:tier", handlers.AdminUpdatePlan)
	adminGroup.Delete("/plans/:tier", handlers.AdminDeletePlan)

	adminGroup.Get("/gdrive/config", handlers.AdminGetGDriveConfig)
	adminGroup.Put("/gdrive/config", handlers.AdminUpdateGDriveConfig)
	adminGroup.Post("/gdrive/sync", handlers.AdminSyncGDrive)
	adminGroup.Get("/gdrive/oauth/url", handlers.AdminGDriveOAuthURL)
	adminGroup.Post("/gdrive/oauth/disconnect", handlers.AdminGDriveDisconnect)
	adminGroup.Get("/gdrive/folders", handlers.AdminGDriveFolders)
	adminGroup.Put("/gdrive/folder", handlers.AdminGDriveSetFolder)
	adminGroup.Get("/roms/cache", handlers.AdminRomsCacheStatus)
	adminGroup.Get("/storage", handlers.AdminStorage)
	adminGroup.Post("/roms/cache/run", handlers.AdminRomsCacheRun)
	adminGroup.Get("/gdrive/browse", handlers.AdminGDriveBrowse)
	adminGroup.Get("/gdrive/preview", handlers.AdminGDrivePreview)
	adminGroup.Get("/roms/sources", handlers.AdminRomSources)
	adminGroup.Post("/roms/sources", handlers.AdminAddRomSource)
	adminGroup.Put("/roms/sources/:id", handlers.AdminUpdateRomSource)
	adminGroup.Delete("/roms/sources/:id", handlers.AdminDeleteRomSource)
	adminGroup.Get("/roms/users", handlers.AdminRomsUsers)
	adminGroup.Get("/roms/access", handlers.AdminRomsAccessList)
	adminGroup.Put("/users/:id/roms-access", handlers.AdminSetRomsAccess)
	adminGroup.Post("/roms", handlers.AdminAddRom)
	adminGroup.Delete("/roms/:id", handlers.AdminDeleteRom)

	// Chunked uploads (big files: games and app builds)
	adminGroup.Post("/uploads", handlers.AdminStartUpload)
	adminGroup.Get("/uploads/:id", handlers.AdminUploadStatus)
	adminGroup.Put("/uploads/:id", handlers.AdminUploadChunk)

	// Native games (abandonware / native builds) per platform
	adminGroup.Get("/native-games", handlers.AdminListNativeGames)
	adminGroup.Post("/native-games", handlers.AdminCreateNativeGame)
	adminGroup.Put("/native-games/:slug", handlers.AdminUpdateNativeGame)
	adminGroup.Delete("/native-games/:slug", handlers.AdminDeleteNativeGame)
	adminGroup.Post("/native-games/:slug/cover", handlers.AdminUploadNativeCover)
	adminGroup.Post("/native-games/:slug/builds", handlers.AdminAddNativeBuild)
	adminGroup.Put("/native-games/:slug/builds/:platform", handlers.AdminUpdateNativeBuild)
	adminGroup.Delete("/native-games/:slug/builds/:platform", handlers.AdminDeleteNativeBuild)

	// Builds of the MemoryCard app (the /baixar page and the auto-updater read these)
	adminGroup.Get("/app-releases", handlers.AdminListAppReleases)
	adminGroup.Post("/app-releases", handlers.AdminCreateAppRelease)
	adminGroup.Delete("/app-releases/:id", handlers.AdminDeleteAppRelease)

	// Community port submissions ("Enviar para aprovação" in the app)
	adminGroup.Get("/ports/submissions", handlers.AdminListPortSubmissions)
	adminGroup.Post("/ports/submissions/:id/approve", handlers.AdminApprovePortSubmission)
	adminGroup.Post("/ports/submissions/:id/reject", handlers.AdminRejectPortSubmission)
	adminGroup.Delete("/ports/submissions/:id", handlers.AdminDeletePortSubmission)

	adminGroup.Get("/users", handlers.AdminListUsers)
	adminGroup.Get("/users/stats", handlers.AdminUsersStats)
	adminGroup.Post("/users", handlers.AdminCreateUser)
	adminGroup.Get("/users/:id", handlers.AdminGetUser)
	adminGroup.Patch("/users/:id", handlers.AdminPatchUser)
	adminGroup.Delete("/users/:id", handlers.AdminDeleteUser)
	adminGroup.Post("/users/:id/password", handlers.AdminResetPassword)
	adminGroup.Post("/users/:id/sessions/revoke", handlers.AdminRevokeSessions)
	adminGroup.Delete("/users/:id/saves", handlers.AdminDeleteUserSaves)
	adminGroup.Put("/users/:id/subscription", handlers.UpdateUserSubscription)

	// Users' cloud backups on the owner's Google Drive: plan quota, resumable uploads, dedup,
	// 750 GB/day budget, cleanup after downgrade/cancel (internal/backupstore)
	handlers.MountBackups(app, adminGroup)

	// Native games: public list + downloads
	app.Get("/api/native-games", handlers.ListNativeGames)
	app.Get("/api/native-games/:slug", handlers.GetNativeGame)
	app.Get("/api/native-games/:slug/cover", handlers.NativeGameCover)
	app.Get("/api/native-games/:slug/:platform/:file", handlers.DownloadNativeGame)

	// MemoryCard app builds: newest per platform, download and auto-update
	app.Get("/api/app/releases", handlers.GetAppReleases)
	app.Get("/api/app/download/:platform", handlers.DownloadLatestApp)
	app.Get("/api/app/file/:id", handlers.DownloadAppFile)
	app.Get("/api/app/update/:target/:arch/:current", handlers.AppUpdateCheck)
	app.Post("/api/app/pending-install", handlers.SavePendingInstall)
	app.Get("/api/app/pending-install", handlers.GetPendingInstall)
	app.Delete("/api/app/pending-install", handlers.ClearPendingInstall)

	// Public catalog: recomps, ports and emulators kept up to date by the scraper,
	// with mirrored binaries and scraped artwork (see internal/catalog).
	// The superadmin view of the scraping bots lives under adminGroup (/api/admin/scrape*).
	mountCatalog(app, adminGroup)

	// Player reviews ("avaliações") of catalog ports: our users' + imported from RecompLauncher
	app.Get("/api/reviews", handlers.GetReviews)
	app.Get("/api/reviews/summary", handlers.GetReviewSummaries)
	app.Post("/api/reviews", handlers.AuthMiddleware(), handlers.CreateReview)
	app.Delete("/api/reviews/:id", handlers.AuthMiddleware(), handlers.DeleteReview)

	// Open data: ports + reviews for anyone (CORS "*"), documented in docs/API_PUBLICA.md and /dados
	app.Get("/api/public", handlers.PublicIndex)
	app.Get("/api/public/sources", handlers.PublicSourcesList)
	app.Get("/api/public/ports", handlers.PublicPorts)
	app.Get("/api/public/ports/:id", handlers.PublicPortDetail)
	app.Get("/api/public/reviews", handlers.PublicReviews)

	// Community ports: users submit from the app, the superadmin approves, approved ones are public
	app.Get("/api/ports/community", handlers.GetCommunityPorts)
	app.Post("/api/ports/submissions", handlers.AuthMiddleware(), handlers.CreatePortSubmission)
	app.Get("/api/ports/submissions/mine", handlers.AuthMiddleware(), handlers.MyPortSubmissions)

	// Convenience redirect for Desktop App Auth if it uses API URL
	app.Get("/auth/desktop", func(c *fiber.Ctx) error {
		site := os.Getenv("SITE_URL")
		if site == "" {
			site = "https://memorycard.cloud"
		}
		return c.Redirect(site + "/auth/desktop")
	})

	// Our own app installers (MemoryCard-windows-x64-setup.exe, ...) linked from the landing page
	appReleases := os.Getenv("APP_RELEASES_DIR")
	if appReleases == "" {
		appReleases = "./data/app-releases"
	}
	app.Static("/downloads/app", appReleases, fiber.Static{Download: true, ByteRange: true})

	// Landing page (static build of /landing) served by the API when LANDING_DIR is set
	if landingDir != "" {
		app.Use("/play", playHeadersMiddleware(landingDir))
		app.Static("/", landingDir, fiber.Static{Compress: true, MaxAge: 3600})
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	app.Listen(":" + port)
}
