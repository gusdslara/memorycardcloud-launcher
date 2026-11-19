package handlers

import (
	"fmt"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/gdrive"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

// GetPlans returns available plans.
// Hides secret plans from public users unless include_secret=true is passed.
func GetPlans(c *fiber.Ctx) error {
	var plans []models.Plan
	database.DB.Order("monthly_price ASC").Find(&plans)

	if len(plans) == 0 {
		SeedDefaultPlans()
		database.DB.Order("monthly_price ASC").Find(&plans)
	} else {
		// Backfill existing plans if storage_limit_bytes or names are missing
		for i := range plans {
			if plans[i].StorageLimitBytes == 0 {
				plans[i].StorageLimitBytes = models.GetPlanStorageLimit(plans[i].Tier)
				plans[i].StorageDisplay = gdrive.FormatBytes(plans[i].StorageLimitBytes)
				if plans[i].Name == "" {
					plans[i].Name = strings.ToUpper(plans[i].Tier[:1]) + plans[i].Tier[1:] + " Plan"
				}
				if strings.EqualFold(plans[i].Tier, "exclusive") || strings.EqualFold(plans[i].Tier, "diamond") {
					plans[i].HasRomsAccess = true
				}
				if strings.EqualFold(plans[i].Tier, "exclusive") {
					plans[i].IsSecret = true
				}
				database.DB.Save(&plans[i])
			}
		}
	}

	// Filter out secret plans for public listing
	includeSecret := c.Query("include_secret") == "true"
	if !includeSecret {
		// The storefront only sells the three cloud plans; other tiers (exclusive, custom ones) stay
		// assigned to whoever has them but are not listed.
		publicPlans := []models.Plan{}
		for _, p := range plans {
			if !p.IsSecret && IsShowcaseTier(p.Tier) {
				publicPlans = append(publicPlans, p)
			}
		}
		return c.JSON(publicPlans)
	}

	return c.JSON(plans)
}

// AdminGetPlans returns all plans including secret plans and full metadata
func AdminGetPlans(c *fiber.Ctx) error {
	var plans []models.Plan
	database.DB.Order("monthly_price ASC").Find(&plans)

	if len(plans) == 0 {
		SeedDefaultPlans()
		database.DB.Order("monthly_price ASC").Find(&plans)
	}

	return c.JSON(plans)
}

// AdminCreatePlan creates a new subscription plan tier
func AdminCreatePlan(c *fiber.Ctx) error {
	var plan models.Plan
	if err := c.BodyParser(&plan); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid plan payload"})
	}

	plan.Tier = strings.ToLower(strings.TrimSpace(plan.Tier))
	if plan.Tier == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Plan tier ID is required"})
	}

	// Check if tier already exists
	var existing models.Plan
	if err := database.DB.Where("LOWER(tier) = ?", plan.Tier).First(&existing).Error; err == nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "A plan with this tier ID already exists"})
	}

	if plan.Name == "" {
		plan.Name = strings.ToUpper(plan.Tier[:1]) + plan.Tier[1:] + " Plan"
	}

	if plan.StorageLimitBytes <= 0 {
		plan.StorageLimitBytes = 10 * 1024 * 1024 * 1024 // 10 GB default
	}

	if plan.StorageDisplay == "" {
		plan.StorageDisplay = gdrive.FormatBytes(plan.StorageLimitBytes)
	}

	plan.CreatedAt = time.Now()
	plan.UpdatedAt = time.Now()

	if err := database.DB.Create(&plan).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create plan"})
	}

	return c.Status(fiber.StatusCreated).JSON(plan)
}

// AdminUpdatePlan updates a single plan tier
func AdminUpdatePlan(c *fiber.Ctx) error {
	tier := strings.ToLower(c.Params("tier"))
	var existing models.Plan
	if err := database.DB.Where("LOWER(tier) = ?", tier).First(&existing).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Plan not found"})
	}

	var req models.Plan
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid plan update payload"})
	}

	if req.Name != "" {
		existing.Name = req.Name
	}
	if req.Description != "" {
		existing.Description = req.Description
	}
	existing.MonthlyPrice = req.MonthlyPrice
	existing.YearlyPrice = req.YearlyPrice
	existing.MonthlyDiscount = req.MonthlyDiscount
	existing.YearlyDiscount = req.YearlyDiscount
	existing.IsPromoActive = req.IsPromoActive
	existing.PromoEndsAt = req.PromoEndsAt
	existing.Url = req.Url

	if req.StorageLimitBytes > 0 {
		existing.StorageLimitBytes = req.StorageLimitBytes
		if req.StorageDisplay != "" {
			existing.StorageDisplay = req.StorageDisplay
		} else {
			existing.StorageDisplay = gdrive.FormatBytes(req.StorageLimitBytes)
		}
	} else if req.StorageDisplay != "" {
		existing.StorageDisplay = req.StorageDisplay
	}

	existing.HasRomsAccess = req.HasRomsAccess
	existing.IsSecret = req.IsSecret
	existing.UpdatedAt = time.Now()

	if err := database.DB.Save(&existing).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to update plan"})
	}

	return c.JSON(existing)
}

// AdminDeletePlan removes a plan tier
func AdminDeletePlan(c *fiber.Ctx) error {
	tier := strings.ToLower(c.Params("tier"))

	// Check if any users have this plan
	var userCount int64
	database.DB.Model(&models.User{}).Where("LOWER(subscription_plan) = ?", tier).Count(&userCount)
	if userCount > 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"message": fmt.Sprintf("Cannot delete plan '%s': %d users currently have this subscription. Reassign their plan first.", tier, userCount),
		})
	}

	if err := database.DB.Where("LOWER(tier) = ?", tier).Delete(&models.Plan{}).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to delete plan"})
	}

	return c.JSON(fiber.Map{"message": fmt.Sprintf("Plan '%s' deleted successfully", tier)})
}

// Cloud plans sold on the storefront (app PlansModal and site /planos). Yearly = 10x monthly
// (2 months free), the same rule the previous defaults used (9.99 -> 99.90). Every plan also
// includes "Sem anúncios para sempre" on its first confirmed payment (see webhook.go).
const (
	gib = int64(1024 * 1024 * 1024)
	tib = 1024 * gib
)

var showcasePlans = []models.Plan{
	{
		Tier: "silver", Name: "Silver Plan",
		Description:  "Backup automático na nuvem dos saves de jogos e emuladores. Inclui Sem anúncios para sempre.",
		MonthlyPrice: 15, YearlyPrice: 150,
		StorageLimitBytes: 5 * gib, StorageDisplay: "5 GB",
	},
	{
		Tier: "gold", Name: "Gold Plan",
		Description:  "Mais espaço para saves e históricos longos. Inclui Sem anúncios para sempre.",
		MonthlyPrice: 30, YearlyPrice: 300,
		StorageLimitBytes: 30 * gib, StorageDisplay: "30 GB",
	},
	{
		Tier: "diamond", Name: "Diamond Plan",
		Description:  "Espaço de sobra para todos os seus saves. Inclui Sem anúncios para sempre.",
		MonthlyPrice: 50, YearlyPrice: 500,
		// The family grant (applyFamilyAccess / admin applyPlan) still uses this tier for the private
		// library; buying it never grants the library (only user.RomsAccess does, set by the superadmin).
		StorageLimitBytes: 100 * gib, StorageDisplay: "100 GB", HasRomsAccess: true,
	},
}

// Old default prices: rows still at these values are moved to the new storefront prices on startup.
// Rows an admin already edited (any other price) are left alone.
var legacyDefaultMonthly = map[string]float64{"silver": 9.99, "gold": 29.90, "diamond": 49.90}

// IsShowcaseTier: silver, gold and diamond are the only tiers listed and sold.
func IsShowcaseTier(tier string) bool {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "silver", "gold", "diamond":
		return true
	}
	return false
}

func samePrice(a, b float64) bool { return a-b < 0.005 && b-a < 0.005 }

// SeedDefaultPlans seeds initial default subscription plans
func SeedDefaultPlans() {
	defaults := append([]models.Plan{}, showcasePlans...)
	defaults = append(defaults, models.Plan{
		Tier:              "exclusive",
		Name:              "Secret Vault Tier",
		Description:       "Secret superadmin-managed tier with 100TB unlimited Google Drive space & full ROMs repository access.",
		StorageLimitBytes: 100 * tib,
		StorageDisplay:    "100 TB Unlimited",
		HasRomsAccess:     true,
		IsSecret:          true,
	})

	for _, p := range defaults {
		var existing models.Plan
		if err := database.DB.Where("LOWER(tier) = LOWER(?)", p.Tier).First(&existing).Error; err != nil {
			database.DB.Create(&p)
			continue
		}
		// Price/storage migration of the storefront plans (only rows still at the old defaults).
		if old, ok := legacyDefaultMonthly[strings.ToLower(existing.Tier)]; ok && samePrice(existing.MonthlyPrice, old) {
			database.DB.Model(&models.Plan{}).Where("tier = ?", existing.Tier).Updates(map[string]any{
				"name":                p.Name,
				"description":         p.Description,
				"monthly_price":       p.MonthlyPrice,
				"yearly_price":        p.YearlyPrice,
				"storage_limit_bytes": p.StorageLimitBytes,
				"storage_display":     p.StorageDisplay,
				"is_secret":           false,
				"updated_at":          time.Now(),
			})
		}
	}
}
