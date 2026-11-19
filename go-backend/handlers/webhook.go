package handlers

import (
	"fmt"
	"os"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

func HandleAsaasWebhook(c *fiber.Ctx) error {
	// 1. Validate Token (Optional but recommended)
	reqToken := c.Get("asaas-access-token")
	envToken := os.Getenv("ASAAS_WEBHOOK_AccessToken")

	fmt.Printf("[DEBUG] Webhook Token Check - Env: '%s', Req: '%s'\n", envToken, reqToken)

	// Only check if envToken is set
	if envToken != "" && reqToken != envToken {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthorized"})
	}

	// 2. Parse Payload
	type WebhookEvent struct {
		Event   string `json:"event"`
		Payment struct {
			ID           string  `json:"id"`
			Customer     string  `json:"customer"`
			Subscription string  `json:"subscription"`
			Value        float64 `json:"value"`
			Description  string  `json:"description"`
			ExternalRef  string  `json:"externalReference"`
		} `json:"payment"`
	}

	var payload WebhookEvent
	if err := c.BodyParser(&payload); err != nil {
		fmt.Println("Webhook Error: Invalid Payload", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid payload"})
	}

	fmt.Printf("Received Webhook: %s Customer: %s Value: %.2f\n", payload.Event, payload.Payment.Customer, payload.Payment.Value)

	// One-time "Sem anúncios para sempre" charge: never a cloud subscription (its R$ 10 value would
	// otherwise fall in the silver-monthly heuristic below).
	if payload.Payment.Subscription == "" && isAdFreeCharge(payload.Payment.ExternalRef, payload.Payment.Description) {
		return handleAdFreeWebhook(c, payload.Event, payload.Payment.ID, payload.Payment.Customer, payload.Payment.ExternalRef)
	}

	// 3. Find User
	var user models.User
	if err := database.DB.Where("asaas_customer_id = ?", payload.Payment.Customer).First(&user).Error; err != nil {
		// User not found, ignore or log
		fmt.Println("Webhook Ignored: User not found for customer ID", payload.Payment.Customer)
		return c.JSON(fiber.Map{"status": "ignored", "reason": "user not found"})
	}

	// 4. Handle Events
	// 4. Handle Events
	switch payload.Event {
	case "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED":
		// Capture old plan to check for upgrades/switches
		oldPlan := user.SubscriptionPlan

		// Grant/Extend
		user.SubscriptionStatus = "active"

		// Detect Plan and Cycle from Description
		// Description format expected: "Subscription {tier} {period} - MemoryCard.cloud"
		// e.g. "Subscription gold monthly - MemoryCard.cloud"
		// Or "Subscription silver yearly - MemoryCard.cloud"

		desc := payload.Payment.Description
		// Default to current or silver/monthly if parsing fails
		if user.SubscriptionPlan == "none" || user.SubscriptionPlan == "" {
			user.SubscriptionPlan = "silver"
		}

		monthsToAdd := 1

		// Simple string contains check (case insensitive usually, but Asaas sends as provided)
		// We can normalize if needed, but let's check common patterns
		// Or use the value heuristic as backup

		if contains(desc, "yearly") || contains(desc, "Yearly") || contains(desc, "anual") {
			monthsToAdd = 12
		}

		if contains(desc, "silver") || contains(desc, "Silver") {
			user.SubscriptionPlan = "silver"
		} else if contains(desc, "gold") || contains(desc, "Gold") {
			user.SubscriptionPlan = "gold"
		} else if contains(desc, "diamond") || contains(desc, "Diamond") {
			user.SubscriptionPlan = "diamond"
		} else if tier, months, ok := PlanFromPaymentValue(payload.Payment.Value); ok {
			// Fallback to the value when the description doesn't help
			user.SubscriptionPlan = tier
			monthsToAdd = months
		}

		user.StorageLimit = models.GetPlanStorageLimit(user.SubscriptionPlan)

		// Calculate new expiration
		now := time.Now()
		var newExpire time.Time

		// If plan changed (upgrade/downgrade), reset cycle from NOW.
		// If same plan, extend.
		if oldPlan != user.SubscriptionPlan || oldPlan == "none" || oldPlan == "" {
			newExpire = now.AddDate(0, monthsToAdd, 0)
		} else {
			// If currently active and not expired, extend from current expiry
			if user.SubscriptionExpiresAt != nil && user.SubscriptionExpiresAt.After(now) {
				newExpire = user.SubscriptionExpiresAt.AddDate(0, monthsToAdd, 0)
			} else {
				// Start from now
				newExpire = now.AddDate(0, monthsToAdd, 0)
			}
		}
		user.SubscriptionExpiresAt = &newExpire

		// Every cloud plan includes "Sem anúncios para sempre": the first confirmed payment of a
		// subscription grants it for good (it stays after a cancel; a refund of that payment revokes).
		if !user.AdFreeLifetime && payload.Payment.ID != "" {
			now := time.Now()
			user.AdFreeLifetime, user.AdFreeSince, user.AdFreePaymentID = true, &now, payload.Payment.ID
			fmt.Printf("User %s is ad-free forever (cloud plan payment %s)\n", user.Email, payload.Payment.ID)
		}

		fmt.Printf("User %s subscription active/extended. Plan: %s. Exp: %s\n", user.Email, user.SubscriptionPlan, newExpire.Format(time.RFC3339))
		database.DB.Save(&user)
		BroadcastUpdate(user.ID)

	case "PAYMENT_OVERDUE", "SUBSCRIPTION_DELETED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED":
		if payload.Event == "PAYMENT_REFUNDED" || payload.Event == "PAYMENT_CHARGEBACK_REQUESTED" {
			// Refund/chargeback of the payment that granted "Sem anúncios para sempre" takes it back.
			if revoked, err := RevokeAdFree(&user, payload.Payment.ID); err == nil && revoked {
				fmt.Printf("User %s ad-free revoked (%s of %s)\n", user.Email, payload.Event, payload.Payment.ID)
				BroadcastUpdate(user.ID)
			}
		}
		if user.SubscriptionStatus == "active" {
			fmt.Printf("User %s subscription inactive/overdue/refunded.\n", user.Email)
			user.SubscriptionStatus = "inactive"
			user.SubscriptionPlan = "none"
			user.StorageLimit = models.GetPlanStorageLimit("free")
			database.DB.Save(&user)
			BroadcastUpdate(user.ID)
		}

	case "PAYMENT_CREATED":
		fmt.Println("Payment Created - Waiting for confirmation")
		// Do nothing, wait for confirmation
	}

	return c.JSON(fiber.Map{"status": "ok"})
}

// PlanFromPaymentValue maps a subscription charge value to (tier, months). It matches the current
// storefront prices in the database first (monthly or yearly, so admin price changes keep working),
// then known price ranges, which also cover the previous prices (9.99/29.90/49.90 and 10x yearly).
func PlanFromPaymentValue(val float64) (string, int, bool) {
	if database.DB != nil {
		var plans []models.Plan
		database.DB.Find(&plans)
		for _, p := range plans {
			if !IsShowcaseTier(p.Tier) {
				continue
			}
			if p.MonthlyPrice > 0 && samePrice(val, p.MonthlyPrice) {
				return strings.ToLower(p.Tier), 1, true
			}
			if p.YearlyPrice > 0 && samePrice(val, p.YearlyPrice) {
				return strings.ToLower(p.Tier), 12, true
			}
		}
	}
	switch {
	case val > 8 && val < 20: // 9.99 (old) / 15
		return "silver", 1, true
	case val >= 20 && val < 40: // 29.90 (old) / 30
		return "gold", 1, true
	case val >= 40 && val < 60: // 49.90 (old) / 50
		return "diamond", 1, true
	case val > 90 && val < 160: // 99.90 (old) / 150
		return "silver", 12, true
	case val > 290 && val < 310: // 299.90 (old) / 300
		return "gold", 12, true
	case val > 490 && val < 510: // 499.90 (old) / 500
		return "diamond", 12, true
	}
	return "", 0, false
}

// Helper
func contains(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}
