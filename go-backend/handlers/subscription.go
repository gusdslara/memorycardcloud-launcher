package handlers

import (
	"fmt"
	"os"
	"time"

	"go-backend/database"
	"go-backend/internal/payment"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// GetSubscription returns the subscription status of the authenticated user
func GetSubscription(c *fiber.Ctx) error {
	tokenString := c.Get("Authorization")
	if len(tokenString) > 7 && tokenString[:7] == "Bearer " {
		tokenString = tokenString[7:]
	}

	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(os.Getenv("JWT_SECRET")), nil
	})

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"message": "Unauthenticated",
		})
	}

	claims := token.Claims.(jwt.MapClaims)
	var user models.User
	if err := database.DB.Where("id = ?", claims["sub"]).First(&user).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"message": "User not found",
		})
	}

	return c.JSON(fiber.Map{
		"subscription_status":     user.SubscriptionStatus,
		"subscription_plan":       user.SubscriptionPlan,
		"subscription_expires_at": user.SubscriptionExpiresAt,
		"ad_free":                 user.AdFree,
		"ad_free_lifetime":        user.AdFreeLifetime,
	})
}

// Subscribe handles the subscription process (Asaas Integration)
func Subscribe(c *fiber.Ctx) error {
	type SubscribeRequest struct {
		Tier             string              `json:"tier"`
		Period           string              `json:"period"`
		BillingType      string              `json:"billingType"`
		CpfCnpj          string              `json:"cpfCnpj"`
		Name             string              `json:"name"`
		MobilePhone      string              `json:"mobilePhone"` // Added for Payer Details
		PostalCode       string              `json:"postalCode"`
		AddressNumber    string              `json:"addressNumber"`
		CreditCard       *payment.CreditCard `json:"creditCard,omitempty"`
		CardHolder       *payment.CardHolder `json:"creditCardHolderInfo,omitempty"`
		InstallmentCount int                 `json:"installmentCount"`
	}

	var req SubscribeRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid request body"})
	}

	// Default to Silver Monthly if missing (safeguard)
	if req.Tier == "" {
		req.Tier = "silver"
	}
	if req.Period == "" {
		req.Period = "monthly"
	} else if req.Period != "monthly" && req.Period != "yearly" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid period"})
	}

	// Validate Tier
	// The three storefront cloud plans (exclusive and custom tiers are only granted by the superadmin).
	validTiers := map[string]bool{"silver": true, "gold": true, "diamond": true}
	if !validTiers[req.Tier] {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid tier"})
	}

	// Default billing type to PIX if not specified
	if req.BillingType == "" {
		req.BillingType = "PIX"
	}

	tokenString := c.Get("Authorization")
	if len(tokenString) > 7 && tokenString[:7] == "Bearer " {
		tokenString = tokenString[7:]
	}

	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(os.Getenv("JWT_SECRET")), nil
	})

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"message": "Unauthenticated",
		})
	}

	claims := token.Claims.(jwt.MapClaims)
	var user models.User
	if err := database.DB.Where("id = ?", claims["sub"]).First(&user).Error; err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "User not found"})
	}

	apiKey := os.Getenv("ASAAS_API_KEY")
	if apiKey == "" {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Payment gateway not configured"})
	}

	asaas := payment.NewAsaasClient(apiKey)

	// 2. Identify Plan and Amount
	var plan models.Plan
	if err := database.DB.Where("tier = ?", req.Tier).First(&plan).Error; err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid tier selected"})
	}

	var amount float64
	var cycle string
	if req.Period == "yearly" {
		amount = plan.YearlyPrice
		cycle = "YEARLY"
	} else {
		amount = plan.MonthlyPrice
		cycle = "MONTHLY"
	}

	// INTERCEPT FREE PROMO: Silver Monthly + is_promo_active
	fmt.Printf("DEBUG SUBSCRIBE: Tier=%s Period=%s PromoActive=%v\n", plan.Tier, req.Period, plan.IsPromoActive)
	if plan.Tier == "silver" && req.Period == "monthly" && plan.IsPromoActive {
		// Verify promo dates if needed
		isPromoValid := true
		if plan.PromoEndsAt != nil && *plan.PromoEndsAt != "" {
			promoEnd, err := time.Parse("2006-01-02", *plan.PromoEndsAt)
			if err == nil && time.Now().After(promoEnd) {
				isPromoValid = false
			}
		}

		if isPromoValid {
			// Grant Free Month directly without Asaas
			expiration := time.Now().AddDate(0, 1, 0)
			user.SubscriptionStatus = "active"
			user.SubscriptionPlan = "silver"
			user.SubscriptionExpiresAt = &expiration
			user.StorageLimit = models.GetPlanStorageLimit("silver")
			database.DB.Save(&user)

			return c.JSON(fiber.Map{
				"message":         "Free monthly promo applied successfully!",
				"subscription_id": "promo_free_" + fmt.Sprintf("%d", time.Now().Unix()),
				"status":          "ACTIVE",
				"is_promo":        true,
			})
		}
	}

	// 1. Ensure Customer Exists
	if user.AsaasCustomerID == "" {
		// Determine Customer Data: Prioritize Request -> Fallback to User
		customerName := req.Name
		if customerName == "" {
			customerName = user.Email
		}

		customerCpf := req.CpfCnpj
		if customerCpf == "" {
			customerCpf = user.CpfCnpj
		}

		customerPhone := req.MobilePhone
		if customerPhone == "" {
			customerPhone = user.MobilePhone
		}

		customerID, err := asaas.CreateCustomer(payment.CustomerRequest{
			Name:          customerName,
			Email:         user.Email,
			CpfCnpj:       customerCpf,
			MobilePhone:   customerPhone,
			PostalCode:    req.PostalCode,
			AddressNumber: req.AddressNumber,
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create payment profile: " + err.Error()})
		}

		user.AsaasCustomerID = customerID
		// Save immediately to avoid dual creation
		database.DB.Save(&user)
	}
	// Always update local user details with latest provided
	if req.Name != "" {
		user.Name = req.Name
	}
	if req.CpfCnpj != "" {
		user.CpfCnpj = req.CpfCnpj
	}
	if req.MobilePhone != "" {
		user.MobilePhone = req.MobilePhone
	}
	if req.PostalCode != "" {
		user.PostalCode = req.PostalCode
	}
	if req.AddressNumber != "" {
		user.AddressNumber = req.AddressNumber
	}
	// Save updates (Name, Phone, etc)
	database.DB.Save(&user)

	// Update Customer in Asaas if exists
	if user.AsaasCustomerID != "" {
		customerName := user.Name
		if customerName == "" {
			customerName = user.Email
		}
		customerReq := payment.CustomerRequest{
			Name:          customerName,
			CpfCnpj:       user.CpfCnpj,
			Email:         user.Email,
			MobilePhone:   user.MobilePhone,
			PostalCode:    user.PostalCode,
			AddressNumber: user.AddressNumber,
		}
		if err := asaas.UpdateCustomer(user.AsaasCustomerID, customerReq); err != nil {
			// Log error but maybe proceed? Or fail?
			// Failing is safer to ensure data consistency especially for refund/boleto rules.
			fmt.Printf("Error updating customer in Asaas: %v\n", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to update customer data in payment provider"})
		}
	}

	// 3. Cancel existing subscription if any
	if user.AsaasSubscriptionID != "" {
		// We try to cancel, but don't block if it fails (maybe already cancelled)
		_ = asaas.DeleteSubscription(user.AsaasSubscriptionID)
		// We could log this error
	}

	// Due date: Asaas requires it for subscriptions too (first payment)
	// Usually "today" or "tomorrow". Let's set to today.
	// Asaas might auto-adjust if slightly in past, but safe to use today or tomorrow.
	nextDueDate := time.Now().Format("2006-01-02")

	// Check for active promotion (Logic: +1 Month)
	description := fmt.Sprintf("Subscription %s %s - MemoryCard.cloud", req.Tier, req.Period)
	// Note: For subscriptions, "Promo" logic of free month is handled by NextDueDate being +1 month?
	// OR we just use the description. The user logic had description update.
	// If we want to give 1 month free, we should set NextDueDate to +1 month.
	if plan.IsPromoActive {
		isPromoValid := true
		if plan.PromoEndsAt != nil && *plan.PromoEndsAt != "" {
			promoEnd, err := time.Parse("2006-01-02", *plan.PromoEndsAt)
			if err == nil && time.Now().After(promoEnd) {
				isPromoValid = false
			}
		}

		if isPromoValid {
			description += " (+1 Month Free)"
			// Actually apply the free month by pushing due date
			nextDueDate = time.Now().AddDate(0, 1, 0).Format("2006-01-02")
		}
	}

	// Calculate installment value if needed
	var installmentValue float64
	if req.InstallmentCount > 1 {
		installmentValue = amount / float64(req.InstallmentCount)
	}

	// 4. Create Subscription
	subReq := payment.SubscriptionRequest{
		Customer:         user.AsaasCustomerID,
		BillingType:      req.BillingType,
		Value:            amount,
		NextDueDate:      nextDueDate,
		Cycle:            cycle,
		Description:      description,
		CreditCard:       req.CreditCard,
		CreditCardHolder: req.CardHolder,
		InstallmentCount: req.InstallmentCount,
		InstallmentValue: installmentValue,
	}

	subResp, err := asaas.CreateSubscription(subReq)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create subscription: " + err.Error()})
	}

	// 5. Update User
	user.AsaasSubscriptionID = subResp.ID
	database.DB.Save(&user)

	// 6. Get Payment Details (for QR Code / Invoice)
	// Subscriptions generate payments. We need the first one to show to the user.
	payments, err := asaas.ListSubscriptionPayments(subResp.ID)

	var firstPaymentID, invoiceURL, pixCode, pixImg, status string
	status = subResp.Status

	if err == nil && len(payments) > 0 {
		// Usually the first one is the pending one
		p := payments[0]
		firstPaymentID = p.ID
		invoiceURL = p.InvoiceUrl
		status = p.Status

		if req.BillingType == "PIX" {
			pixImg, pixCode, _ = asaas.GetPixQrCode(p.ID)
		}
	}

	return c.JSON(fiber.Map{
		"message":         "Subscription initiated",
		"subscription_id": subResp.ID,
		"payment_id":      firstPaymentID,
		"invoice_url":     invoiceURL,
		"pix_qrcode":      pixCode,
		"pix_image":       pixImg,
		"status":          status,
	})
}
