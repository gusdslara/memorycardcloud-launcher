package handlers

import (
	"fmt"
	"time"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// AdminMiddleware ensures the user is the owner/admin
// AdminMiddleware ensures the user is the owner/admin
func AdminMiddleware(c *fiber.Ctx) error {
	userToken := c.Locals("user").(*jwt.Token)
	claims := userToken.Claims.(jwt.MapClaims)
	userID := claims["sub"]

	fmt.Printf("[DEBUG] AdminMiddleware: Checking Admin Access for UserID=%v\n", userID)

	var user models.User
	// optimize: only select is_admin field
	if err := database.DB.Select("is_admin").First(&user, userID).Error; err != nil {
		fmt.Printf("[DEBUG] AdminMiddleware: User not found for ID=%v\n", userID)
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "User not found"})
	}

	fmt.Printf("[DEBUG] AdminMiddleware: UserID=%v, IsAdmin=%v\n", userID, user.IsAdmin)

	if !user.IsAdmin {
		fmt.Printf("[DEBUG] AdminMiddleware: Access Denied for UserID=%v\n", userID)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"message": "Access denied. Admin only.",
		})
	}
	return c.Next()
}

type UpdateSubscriptionRequest struct {
	PlanTier   string `json:"plan_tier"`   // silver, gold, diamond, exclusive, none
	Months     int    `json:"months"`      // Number of months to ADD or SET
	IsSet      bool   `json:"is_set"`      // If true, sets expiration to Now + Months. If false, adds to current.
	ExpireDate string `json:"expire_date"` // Specific date YYYY-MM-DD
	IsAdmin    *bool  `json:"is_admin"`    // Pointer to allow toggle
}

// UpdateUserSubscription modifies a user's plan and expiration
func UpdateUserSubscription(c *fiber.Ctx) error {
	id := c.Params("id")
	var req UpdateSubscriptionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid request"})
	}

	var user models.User
	if err := database.DB.First(&user, id).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "User not found"})
	}

	if req.IsAdmin != nil {
		user.IsAdmin = *req.IsAdmin
	}

	// Update Plan
	if req.PlanTier != "" {
		user.SubscriptionPlan = req.PlanTier
		if req.PlanTier == "none" {
			user.SubscriptionStatus = "inactive"
			user.StorageLimit = models.GetPlanStorageLimit("free")
		} else {
			user.SubscriptionStatus = "active"
			user.StorageLimit = models.GetPlanStorageLimit(req.PlanTier)
		}
	}

	// Update Expiration
	if req.ExpireDate != "" {
		// Parse date (YYYY-MM-DD)
		parsedTime, err := time.Parse("2006-01-02", req.ExpireDate)
		if err == nil {
			// Set to end of that day?? Or just that time. Usually end of day is better for subs.
			// Let's just set it to the parsed time (00:00:00).
			user.SubscriptionExpiresAt = &parsedTime
			if user.SubscriptionPlan != "none" {
				user.SubscriptionStatus = "active"
			}
		}
	} else if req.Months > 0 {
		now := time.Now()
		var newExpiration time.Time

		if req.IsSet || user.SubscriptionExpiresAt == nil || user.SubscriptionExpiresAt.Before(now) {
			// Start from now
			newExpiration = now.AddDate(0, req.Months, 0)
		} else {
			// Extend existing
			newExpiration = user.SubscriptionExpiresAt.AddDate(0, req.Months, 0)
		}
		user.SubscriptionExpiresAt = &newExpiration

		// Ensure status is active if we added time
		if user.SubscriptionPlan != "none" {
			user.SubscriptionStatus = "active"
		}
	}

	database.DB.Save(&user)

	return c.JSON(user)
}

// --- Plan Management ---

type UpdatePlansRequest struct {
	Plans []models.Plan `json:"plans"`
}

// UpdatePlans updates plan prices/discounts, storage limits, and access flags
func UpdatePlans(c *fiber.Ctx) error {
	var req UpdatePlansRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid input"})
	}

	tx := database.DB.Begin()
	for _, p := range req.Plans {
		if p.Tier == "" {
			continue
		}
		updateMap := map[string]interface{}{
			"name":                p.Name,
			"description":         p.Description,
			"monthly_price":       p.MonthlyPrice,
			"yearly_price":        p.YearlyPrice,
			"monthly_discount":    p.MonthlyDiscount,
			"yearly_discount":     p.YearlyDiscount,
			"is_promo_active":     p.IsPromoActive,
			"promo_ends_at":       p.PromoEndsAt,
			"url":                 p.Url,
			"storage_limit_bytes": p.StorageLimitBytes,
			"storage_display":     p.StorageDisplay,
			"has_roms_access":     p.HasRomsAccess,
			"is_secret":           p.IsSecret,
		}
		if p.StorageLimitBytes > 0 && p.StorageDisplay == "" {
			updateMap["storage_display"] = fmt.Sprintf("%d GB", p.StorageLimitBytes/(1024*1024*1024))
		}
		if err := tx.Model(&models.Plan{}).Where("LOWER(tier) = LOWER(?)", p.Tier).Updates(updateMap).Error; err != nil {
			tx.Rollback()
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to update plans"})
		}
	}
	tx.Commit()

	return c.Status(fiber.StatusOK).JSON(fiber.Map{"message": "Plans updated successfully"})
}
