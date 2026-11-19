package handlers

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/payment"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// "Sem anúncios para sempre": one-time purchase (R$ 10 by default) that removes the ads from the app
// for that account forever. Independent of the cloud backup plans (a user can buy either or both);
// an active cloud plan also hides the ads (see models.User.HasAdFree).

const (
	AdFreeProductID    = "ad_free"
	AdFreeTitle        = "Sem anúncios para sempre"
	AdFreeDescription  = "Sem anúncios para sempre - MemoryCard.cloud"
	adFreeRefPrefix    = "adfree:"
	defaultAdFreePrice = 10.00
)

// AdFreePrice is the price in BRL (AD_FREE_PRICE overrides the default R$ 10,00).
func AdFreePrice() float64 {
	if v := strings.TrimSpace(os.Getenv("AD_FREE_PRICE")); v != "" {
		if f, err := strconv.ParseFloat(strings.Replace(v, ",", ".", 1), 64); err == nil && f > 0 {
			return f
		}
	}
	return defaultAdFreePrice
}

// AdFreeExternalRef is the Asaas externalReference of the ad-free charge of a user.
func AdFreeExternalRef(userID uint) string {
	return fmt.Sprintf("%s%d", adFreeRefPrefix, userID)
}

// ParseAdFreeRef returns the user ID of an ad-free externalReference ("adfree:<id>").
func ParseAdFreeRef(ref string) (uint, bool) {
	ref = strings.TrimSpace(ref)
	if !strings.HasPrefix(ref, adFreeRefPrefix) {
		return 0, false
	}
	id, err := strconv.ParseUint(strings.TrimPrefix(ref, adFreeRefPrefix), 10, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	return uint(id), true
}

// isAdFreeCharge recognizes the ad-free charge by its reference or, for charges created by hand in the
// Asaas dashboard, by its description.
func isAdFreeCharge(externalRef, description string) bool {
	if strings.HasPrefix(strings.TrimSpace(externalRef), adFreeRefPrefix) {
		return true
	}
	d := strings.ToLower(description)
	return strings.Contains(d, "sem anúncios") || strings.Contains(d, "sem anuncios") || strings.Contains(d, "ad-free") || strings.Contains(d, "ad free")
}

// GrantAdFree marks the user ad-free forever (idempotent).
func GrantAdFree(user *models.User, paymentID string) error {
	if user.AdFreeLifetime {
		return nil
	}
	now := time.Now()
	updates := map[string]any{"ad_free_lifetime": true, "ad_free_since": now, "ad_free_payment_id": paymentID}
	if err := database.DB.Model(&models.User{}).Where("id = ?", user.ID).Updates(updates).Error; err != nil {
		return err
	}
	user.AdFreeLifetime = true
	user.AdFreeSince = &now
	user.AdFreePaymentID = paymentID
	user.AdFree = true
	return nil
}

// RevokeAdFree undoes a purchase that was refunded or charged back. Only the payment that granted it
// can revoke it (an admin grant or a newer purchase stays).
func RevokeAdFree(user *models.User, paymentID string) (bool, error) {
	if !user.AdFreeLifetime || paymentID == "" || user.AdFreePaymentID != paymentID {
		return false, nil
	}
	updates := map[string]any{"ad_free_lifetime": false, "ad_free_since": nil, "ad_free_payment_id": ""}
	if err := database.DB.Model(&models.User{}).Where("id = ?", user.ID).Updates(updates).Error; err != nil {
		return false, err
	}
	user.AdFreeLifetime = false
	user.AdFreeSince = nil
	user.AdFreePaymentID = ""
	user.AdFree = user.HasAdFree(time.Now())
	return true, nil
}

// GetAdFreeOffer: GET /api/purchases/ad-free (public). The offer shown by the app and the site.
func GetAdFreeOffer(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"product":     AdFreeProductID,
		"title":       AdFreeTitle,
		"description": "Apoie o projeto e fique sem anúncios para sempre.",
		"price":       AdFreePrice(),
		"currency":    "BRL",
		"one_time":    true,
	})
}

func purchaseUser(c *fiber.Ctx) (*models.User, error) {
	tok, ok := c.Locals("user").(*jwt.Token)
	if !ok || tok == nil {
		return nil, errors.New("no token")
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return nil, errors.New("invalid claims")
	}
	var user models.User
	if err := database.DB.First(&user, claims["sub"]).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

// PurchaseAdFree: POST /api/purchases/ad-free (auth). Creates a one-time Asaas charge and returns the
// invoice link (PIX, boleto or card on the Asaas page) and, for PIX, the QR code. The Asaas webhook
// (PAYMENT_CONFIRMED / PAYMENT_RECEIVED with externalReference "adfree:<user id>") grants it.
func PurchaseAdFree(c *fiber.Ctx) error {
	type purchaseRequest struct {
		BillingType   string              `json:"billingType"` // UNDEFINED (payer chooses), PIX, BOLETO, CREDIT_CARD
		CpfCnpj       string              `json:"cpfCnpj"`
		Name          string              `json:"name"`
		MobilePhone   string              `json:"mobilePhone"`
		PostalCode    string              `json:"postalCode"`
		AddressNumber string              `json:"addressNumber"`
		CreditCard    *payment.CreditCard `json:"creditCard,omitempty"`
		CardHolder    *payment.CardHolder `json:"creditCardHolderInfo,omitempty"`
	}

	user, err := purchaseUser(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Faça login para continuar"})
	}

	var req purchaseRequest
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid request body"})
		}
	}
	req.BillingType = strings.ToUpper(strings.TrimSpace(req.BillingType))
	switch req.BillingType {
	case "":
		req.BillingType = "UNDEFINED"
	case "UNDEFINED", "PIX", "BOLETO", "CREDIT_CARD":
	default:
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Invalid billing type"})
	}

	if user.AdFreeLifetime {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "already_ad_free", "message": "Sua conta já está sem anúncios para sempre.", "ad_free": true})
	}

	apiKey := os.Getenv("ASAAS_API_KEY")
	if apiKey == "" {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": "Payment gateway not configured"})
	}
	asaas := payment.NewAsaasClient(apiKey)

	// Keep the profile up to date with what the payer typed.
	profile := map[string]any{}
	if req.Name != "" && req.Name != user.Name {
		user.Name, profile["name"] = req.Name, req.Name
	}
	if req.CpfCnpj != "" && req.CpfCnpj != user.CpfCnpj {
		user.CpfCnpj, profile["cpf_cnpj"] = req.CpfCnpj, req.CpfCnpj
	}
	if req.MobilePhone != "" && req.MobilePhone != user.MobilePhone {
		user.MobilePhone, profile["mobile_phone"] = req.MobilePhone, req.MobilePhone
	}
	if req.PostalCode != "" && req.PostalCode != user.PostalCode {
		user.PostalCode, profile["postal_code"] = req.PostalCode, req.PostalCode
	}
	if req.AddressNumber != "" && req.AddressNumber != user.AddressNumber {
		user.AddressNumber, profile["address_number"] = req.AddressNumber, req.AddressNumber
	}
	if len(profile) > 0 {
		database.DB.Model(&models.User{}).Where("id = ?", user.ID).Updates(profile)
	}

	customerName := user.Name
	if customerName == "" {
		customerName = user.Email
	}
	if user.AsaasCustomerID == "" {
		// Asaas needs the CPF/CNPJ of the payer to issue a charge.
		if strings.TrimSpace(user.CpfCnpj) == "" {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"code": "cpf_required", "message": "Informe seu CPF para gerar o pagamento."})
		}
		customerID, err := asaas.CreateCustomer(payment.CustomerRequest{
			Name:          customerName,
			Email:         user.Email,
			CpfCnpj:       user.CpfCnpj,
			MobilePhone:   user.MobilePhone,
			PostalCode:    user.PostalCode,
			AddressNumber: user.AddressNumber,
			ExternalRef:   fmt.Sprintf("user:%d", user.ID),
		})
		if err != nil {
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": "Failed to create payment profile: " + err.Error()})
		}
		user.AsaasCustomerID = customerID
		database.DB.Model(&models.User{}).Where("id = ?", user.ID).Update("asaas_customer_id", customerID)
	} else if len(profile) > 0 {
		// Best effort: the charge works with the data Asaas already has.
		if err := asaas.UpdateCustomer(user.AsaasCustomerID, payment.CustomerRequest{
			Name: customerName, Email: user.Email, CpfCnpj: user.CpfCnpj, MobilePhone: user.MobilePhone,
			PostalCode: user.PostalCode, AddressNumber: user.AddressNumber,
		}); err != nil {
			fmt.Printf("[ad-free] could not update Asaas customer %s: %v\n", user.AsaasCustomerID, err)
		}
	}

	pay, err := asaas.CreatePayment(payment.PaymentRequest{
		Customer:         user.AsaasCustomerID,
		BillingType:      req.BillingType,
		Value:            AdFreePrice(),
		DueDate:          time.Now().AddDate(0, 0, 2).Format("2006-01-02"),
		Description:      AdFreeDescription,
		ExternalRef:      AdFreeExternalRef(user.ID),
		CreditCard:       req.CreditCard,
		CreditCardHolder: req.CardHolder,
	})
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": "Failed to create payment: " + err.Error()})
	}

	var pixImg, pixCode string
	if req.BillingType == "PIX" {
		pixImg, pixCode, _ = asaas.GetPixQrCode(pay.ID)
	}

	// Card payments may already come back confirmed: no need to wait for the webhook.
	if pay.Status == "CONFIRMED" || pay.Status == "RECEIVED" {
		if err := GrantAdFree(user, pay.ID); err == nil {
			BroadcastUpdate(user.ID)
		}
	}

	return c.JSON(fiber.Map{
		"message":     "Payment created",
		"product":     AdFreeProductID,
		"payment_id":  pay.ID,
		"invoice_url": pay.InvoiceUrl,
		"pix_qrcode":  pixCode,
		"pix_image":   pixImg,
		"status":      pay.Status,
		"price":       AdFreePrice(),
		"ad_free":     user.AdFreeLifetime,
	})
}

// handleAdFreeWebhook applies an Asaas event about an ad-free charge.
func handleAdFreeWebhook(c *fiber.Ctx, event, paymentID, customerID, externalRef string) error {
	var user models.User
	found := false
	if customerID != "" && database.DB.Where("asaas_customer_id = ?", customerID).First(&user).Error == nil {
		found = true
		if refID, ok := ParseAdFreeRef(externalRef); ok && refID != user.ID {
			fmt.Printf("[ad-free] webhook: reference user %d differs from customer owner %d, using the customer owner\n", refID, user.ID)
		}
	} else if refID, ok := ParseAdFreeRef(externalRef); ok && database.DB.First(&user, refID).Error == nil {
		found = true
	}
	if !found {
		fmt.Println("[ad-free] webhook ignored: user not found for customer", customerID, "ref", externalRef)
		return c.JSON(fiber.Map{"status": "ignored", "reason": "user not found"})
	}

	switch event {
	case "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED":
		if err := GrantAdFree(&user, paymentID); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to grant"})
		}
		fmt.Printf("[ad-free] user %s is ad-free forever (payment %s)\n", user.Email, paymentID)
		BroadcastUpdate(user.ID)
	case "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED":
		revoked, err := RevokeAdFree(&user, paymentID)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to revoke"})
		}
		if revoked {
			fmt.Printf("[ad-free] user %s ad-free revoked (%s, payment %s)\n", user.Email, event, paymentID)
			BroadcastUpdate(user.ID)
		}
	}
	// The cloud subscription is never touched by an ad-free charge.
	return c.JSON(fiber.Map{"status": "ok", "product": AdFreeProductID})
}
