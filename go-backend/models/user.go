package models

import (
	"strings"
	"time"

	"gorm.io/gorm"
)

type User struct {
	gorm.Model
	Email                 string     `gorm:"unique;not null" json:"email"`
	Name                  string     `json:"name"`         // Full Name
	MobilePhone           string     `json:"mobile_phone"` // Unique check handled in logic to allow null/empty
	CpfCnpj               string     `json:"cpf_cnpj"`     // Added CPF/CNPJ field
	PostalCode            string     `json:"postal_code"`  // CEP
	AddressNumber         string     `json:"address_number"`
	Password              string     `json:"-"`
	SubscriptionStatus    string     `json:"subscription_status" gorm:"default:'inactive'"` // active, inactive
	SubscriptionPlan      string     `json:"subscription_plan" gorm:"default:'none'"`       // monthly, yearly, none
	StorageLimit          int64      `json:"storage_limit" gorm:"default:104857600"`        // bytes, default 100MB
	SubscriptionExpiresAt *time.Time `json:"subscription_expires_at"`
	AsaasCustomerID       string     `json:"asaas_customer_id"`
	AsaasSubscriptionID   string     `json:"asaas_subscription_id"`
	CurrentUsage          int64      `json:"current_usage" gorm:"-"` // Calculated field, not stored
	IsAdmin               bool       `json:"is_admin" gorm:"default:false"`
	RomsAccess            bool       `json:"roms_access" gorm:"default:false"` // private ROM library: granted only by a superadmin
	Disabled              bool       `json:"disabled" gorm:"default:false"`    // suspended by the superadmin: cannot log in or refresh
	DisabledReason        string     `json:"-"`
	AdminNote             string     `json:"-"` // private note of the superadmin about the account
	LastLoginAt           *time.Time `json:"last_login_at"`
	LastSeenAt            *time.Time `json:"last_seen_at"` // last login or session refresh

	// "Sem anúncios para sempre": one-time purchase (R$ 10) that removes ads from the app forever.
	AdFreeLifetime  bool       `json:"ad_free_lifetime" gorm:"default:false"`
	AdFreeSince     *time.Time `json:"ad_free_since"`
	AdFreePaymentID string     `json:"-"` // Asaas payment that granted it (refund revokes only this one)
	// AdFree is computed (not stored): lifetime purchase, an active cloud plan or admin. The app hides ads when true.
	AdFree bool `json:"ad_free" gorm:"-"`

	// Terms of Service & LGPD
	TermsAccepted          bool                   `json:"terms_accepted"`
	TermsAcceptedAt        *time.Time             `json:"terms_accepted_at"`
	TermsAcceptedIP        string                 `json:"terms_accepted_ip"`
	TermsAcceptedUserAgent string                 `json:"terms_accepted_user_agent"`
	Preferences            map[string]interface{} `json:"preferences" gorm:"serializer:json"` // User settings/preferences
}

// AdFreeGracePeriod keeps a paid cloud plan ad-free for a few days after the expiry date,
// while the renewal payment is still being confirmed by Asaas.
const AdFreeGracePeriod = 72 * time.Hour

// HasActiveCloudPlan reports whether the user currently has a cloud backup plan (silver, gold, ...).
func (u *User) HasActiveCloudPlan(now time.Time) bool {
	if !strings.EqualFold(u.SubscriptionStatus, "active") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(u.SubscriptionPlan)) {
	case "", "none", "free":
		return false
	}
	if u.SubscriptionExpiresAt != nil && now.After(u.SubscriptionExpiresAt.Add(AdFreeGracePeriod)) {
		return false
	}
	return true
}

// HasAdFree: no ads for lifetime buyers, cloud plan subscribers and admins.
func (u *User) HasAdFree(now time.Time) bool {
	return u.AdFreeLifetime || u.IsAdmin || u.HasActiveCloudPlan(now)
}

// AfterFind fills the computed AdFree flag every time a user is loaded.
func (u *User) AfterFind(tx *gorm.DB) error {
	u.AdFree = u.HasAdFree(time.Now())
	return nil
}

type RefreshToken struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	UserID    uint      `json:"user_id" gorm:"index"`
	Token     string    `json:"token" gorm:"uniqueIndex"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
	Revoked   bool      `json:"revoked"`
}
