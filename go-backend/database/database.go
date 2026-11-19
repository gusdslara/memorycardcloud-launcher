package database

import (
	"log" // Added this import
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"go-backend/models"
)

var DB *gorm.DB

func Connect() {
	log.Println("INITIALIZING SQLITE CONNECTION - FORCING LOCAL_DB")
	// Database file path
	dbName := os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "memorycard.db"
	}

	// Ensure we store it in a persistent location if needed, but for now relative is fine
	// or use an environment variable for the data directory
	dataDir := os.Getenv("DATA_DIR")
	if dataDir != "" {
		// Create directory if it wouldn't exist
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			log.Fatal("Failed to create data directory:", err)
		}
		dbName = filepath.Join(dataDir, dbName)
	}

	var err error
	// Use Pure Go SQLite driver (glebarez)
	// Enable WAL mode for better concurrency performance
	DB, err = gorm.Open(sqlite.Open(dbName+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(on)"), &gorm.Config{})
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	log.Println("Connected to SQLite database successfully:", dbName)

	// Register PlanStorageResolver to dynamically resolve storage limits from Plan table
	models.PlanStorageResolver = func(tier string) int64 {
		if DB == nil {
			return 0
		}
		var plan models.Plan
		if err := DB.Select("storage_limit_bytes").Where("LOWER(tier) = LOWER(?)", tier).First(&plan).Error; err == nil && plan.StorageLimitBytes > 0 {
			return plan.StorageLimitBytes
		}
		return 0
	}
}

func SeedAdmin() {
	adminEmail := os.Getenv("ADMIN_EMAIL")
	adminPassword := os.Getenv("ADMIN_PASSWORD")

	if adminEmail == "" || adminPassword == "" {
		// Only log if one is missing but the other present? Or just silent?
		// User said "admin email... and also the admin password" will be in env.
		if adminEmail != "" || adminPassword != "" {
			log.Println("WARNING: ADMIN_EMAIL or ADMIN_PASSWORD missing. Skipping admin seeding.")
		}
		return
	}

	var user models.User
	// Check if user exists
	if err := DB.Where("email = ?", adminEmail).First(&user).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			// Create Admin
			log.Println("Creating Admin User:", adminEmail)
			hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(adminPassword), 14)
			user = models.User{
				Email:              adminEmail,
				Password:           string(hashedPassword),
				SubscriptionPlan:   "exclusive",
				SubscriptionStatus: "active",
				StorageLimit:       models.GetPlanStorageLimit("exclusive"),
				TermsAccepted:      true,
				IsAdmin:            true,
			}
			if err := DB.Create(&user).Error; err != nil {
				log.Println("Error creating admin user:", err)
			}
		} else {
			log.Println("Error checking for admin user:", err)
		}
	} else {
		// User exists, ensure privileges and update password (optional, but requested "admin password in env")
		// Updating password on every restart might be heavy/annoying if bcrypt matches, but let's check.
		err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(adminPassword))
		if err != nil {
			// Password changed in env, update DB
			log.Println("Updating Admin Password for:", adminEmail)
			hashedPassword, _ := bcrypt.GenerateFromPassword([]byte(adminPassword), 14)
			user.Password = string(hashedPassword)
		}

		user.SubscriptionPlan = "exclusive"
		user.SubscriptionStatus = "active"
		user.StorageLimit = models.GetPlanStorageLimit("exclusive")
		user.IsAdmin = true
		DB.Save(&user)
	}
}
