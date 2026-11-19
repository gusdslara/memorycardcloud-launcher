package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/internal/payment"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
)

func setupPurchasesApp(t *testing.T) *fiber.App {
	t.Helper()
	setupRomsTestDB(t)
	if err := database.DB.AutoMigrate(&models.GameSave{}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ASAAS_WEBHOOK_AccessToken", "")
	t.Setenv("ADMIN_EMAIL", "dono@example.com")
	t.Setenv("AD_FREE_PRICE", "")

	app := fiber.New()
	app.Get("/api/me", Me)
	app.Post("/api/webhooks/asaas", HandleAsaasWebhook)
	app.Get("/api/purchases/ad-free", GetAdFreeOffer)
	app.Post("/api/purchases/ad-free", AuthMiddleware(), PurchaseAdFree)
	return app
}

func webhook(t *testing.T, app *fiber.App, event, paymentID, customer, subscription, ref, desc string, value float64) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"event": event,
		"payment": map[string]any{
			"id": paymentID, "customer": customer, "subscription": subscription,
			"value": value, "description": desc, "externalReference": ref,
		},
	})
	code, out := call(t, app, "", "POST", "/api/webhooks/asaas", string(body))
	if code != 200 {
		t.Fatalf("webhook %s: %d %v", event, code, out)
	}
	return out
}

func reload(t *testing.T, id uint) models.User {
	t.Helper()
	var u models.User
	if err := database.DB.First(&u, id).Error; err != nil {
		t.Fatal(err)
	}
	return u
}

func TestAdFreeWebhookGrantsForeverWithoutTouchingTheCloudPlan(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "fa@example.com", AsaasCustomerID: "cus_1", SubscriptionPlan: "none", SubscriptionStatus: "inactive"}
	database.DB.Create(&u)

	out := webhook(t, app, "PAYMENT_CONFIRMED", "pay_1", "cus_1", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	if out["product"] != AdFreeProductID {
		t.Fatalf("ad-free charge was not routed to the ad-free handler: %v", out)
	}
	got := reload(t, u.ID)
	if !got.AdFreeLifetime || got.AdFreeSince == nil || got.AdFreePaymentID != "pay_1" || !got.AdFree {
		t.Fatalf("not ad-free after payment: %+v", got)
	}
	// R$ 10 would match the silver-monthly value heuristic: it must not become a subscription.
	if got.SubscriptionPlan != "none" || got.SubscriptionStatus != "inactive" || got.SubscriptionExpiresAt != nil {
		t.Fatalf("ad-free purchase changed the cloud plan: plan=%s status=%s", got.SubscriptionPlan, got.SubscriptionStatus)
	}

	// PAYMENT_RECEIVED after PAYMENT_CONFIRMED (card) is idempotent.
	since := *got.AdFreeSince
	webhook(t, app, "PAYMENT_RECEIVED", "pay_1", "cus_1", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	again := reload(t, u.ID)
	if !again.AdFreeLifetime || !again.AdFreeSince.Equal(since) {
		t.Fatalf("second confirmation changed the grant: %+v", again)
	}
}

func TestAdFreeWebhookRefundRevokesOnlyTheGrantingPayment(t *testing.T) {
	app := setupPurchasesApp(t)
	exp := time.Now().AddDate(0, 1, 0)
	u := models.User{Email: "rf@example.com", AsaasCustomerID: "cus_2", SubscriptionPlan: "silver", SubscriptionStatus: "active", SubscriptionExpiresAt: &exp}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_a", "cus_2", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)

	// Refund of another (duplicate) ad-free charge keeps the grant.
	webhook(t, app, "PAYMENT_REFUNDED", "pay_other", "cus_2", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	if !reload(t, u.ID).AdFreeLifetime {
		t.Fatal("refund of another payment revoked the grant")
	}

	webhook(t, app, "PAYMENT_REFUNDED", "pay_a", "cus_2", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	got := reload(t, u.ID)
	if got.AdFreeLifetime || got.AdFreePaymentID != "" {
		t.Fatalf("refund did not revoke: %+v", got)
	}
	// The cloud subscription is independent of the ad-free refund (and still hides the ads).
	if got.SubscriptionPlan != "silver" || got.SubscriptionStatus != "active" || !got.AdFree {
		t.Fatalf("ad-free refund touched the cloud plan: %+v", got)
	}
}

func TestAdFreeWebhookFindsTheUserByReference(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "ref@example.com"}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_RECEIVED", "pay_r", "cus_unknown", "", AdFreeExternalRef(u.ID), "", 10)
	if !reload(t, u.ID).AdFreeLifetime {
		t.Fatal("user was not found by the adfree:<id> reference")
	}
	// A charge created by hand in the Asaas dashboard is recognized by its description.
	v := models.User{Email: "manual@example.com", AsaasCustomerID: "cus_m"}
	database.DB.Create(&v)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_m", "cus_m", "", "", "Sem anúncios para sempre", 10)
	if got := reload(t, v.ID); !got.AdFreeLifetime || got.SubscriptionPlan == "silver" {
		t.Fatalf("manual ad-free charge: %+v", got)
	}
}

func TestCloudPlanFirstPaymentGrantsAdFreeForever(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "sub@example.com", AsaasCustomerID: "cus_s", SubscriptionPlan: "none", SubscriptionStatus: "inactive"}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_s1", "cus_s", "sub_1", "", "Subscription silver monthly - MemoryCard.cloud", 15)
	got := reload(t, u.ID)
	if got.SubscriptionPlan != "silver" || got.SubscriptionStatus != "active" {
		t.Fatalf("subscription not granted: %+v", got)
	}
	if !got.AdFreeLifetime || got.AdFreePaymentID != "pay_s1" || got.AdFreeSince == nil || !got.AdFree {
		t.Fatalf("first cloud plan payment must grant ad-free forever: %+v", got)
	}

	// Renewal keeps the original grant.
	webhook(t, app, "PAYMENT_RECEIVED", "pay_s2", "cus_s", "sub_1", "", "Subscription silver monthly - MemoryCard.cloud", 15)
	if got := reload(t, u.ID); got.AdFreePaymentID != "pay_s1" {
		t.Fatalf("renewal replaced the granting payment: %s", got.AdFreePaymentID)
	}

	// Cancel: the plan goes, "Sem anúncios para sempre" stays.
	webhook(t, app, "SUBSCRIPTION_DELETED", "", "cus_s", "sub_1", "", "", 0)
	got = reload(t, u.ID)
	if got.SubscriptionStatus != "inactive" || !got.AdFreeLifetime || !got.AdFree {
		t.Fatalf("after cancel: status=%s lifetime=%v", got.SubscriptionStatus, got.AdFreeLifetime)
	}

	// Refund of a later renewal does not revoke it.
	webhook(t, app, "PAYMENT_REFUNDED", "pay_s2", "cus_s", "sub_1", "", "", 15)
	if !reload(t, u.ID).AdFreeLifetime {
		t.Fatal("refund of another payment revoked the grant")
	}
}

func TestCloudPlanRefundOfGrantingPaymentRevokesAdFree(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "rb@example.com", AsaasCustomerID: "cus_rb", SubscriptionPlan: "none", SubscriptionStatus: "inactive"}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_g", "cus_rb", "sub_g", "", "Subscription gold yearly - MemoryCard.cloud", 300)
	if got := reload(t, u.ID); got.SubscriptionPlan != "gold" || !got.AdFreeLifetime {
		t.Fatalf("gold yearly: %+v", got)
	}
	webhook(t, app, "PAYMENT_CHARGEBACK_REQUESTED", "pay_g", "cus_rb", "sub_g", "", "", 300)
	got := reload(t, u.ID)
	if got.AdFreeLifetime || got.AdFree || got.SubscriptionStatus != "inactive" {
		t.Fatalf("chargeback of the granting payment: lifetime=%v adFree=%v status=%s", got.AdFreeLifetime, got.AdFree, got.SubscriptionStatus)
	}
}

func TestCloudPlanAlreadyAdFreeKeepsOriginalPurchase(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "both@example.com", AsaasCustomerID: "cus_b"}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_adfree", "cus_b", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_plan", "cus_b", "sub_b", "", "Subscription diamond monthly - MemoryCard.cloud", 50)
	got := reload(t, u.ID)
	if got.SubscriptionPlan != "diamond" || got.AdFreePaymentID != "pay_adfree" {
		t.Fatalf("plan=%s granting payment=%s", got.SubscriptionPlan, got.AdFreePaymentID)
	}
}

func TestPlanFromPaymentValue(t *testing.T) {
	setupPurchasesApp(t)
	cases := []struct {
		val    float64
		tier   string
		months int
	}{
		{15, "silver", 1}, {150, "silver", 12}, {30, "gold", 1}, {300, "gold", 12}, {50, "diamond", 1}, {500, "diamond", 12},
		// previous prices (old subscriptions renewing)
		{9.99, "silver", 1}, {99.90, "silver", 12}, {29.90, "gold", 1}, {299.90, "gold", 12}, {49.90, "diamond", 1}, {499.90, "diamond", 12},
	}
	for _, c := range cases {
		tier, months, ok := PlanFromPaymentValue(c.val)
		if !ok || tier != c.tier || months != c.months {
			t.Errorf("%.2f: got %s/%d/%v, want %s/%d", c.val, tier, months, ok, c.tier, c.months)
		}
	}
	if _, _, ok := PlanFromPaymentValue(1234); ok {
		t.Error("unknown value must not map to a plan")
	}
}

func TestSubscriptionWithoutDescriptionUsesValue(t *testing.T) {
	app := setupPurchasesApp(t)
	u := models.User{Email: "val@example.com", AsaasCustomerID: "cus_v"}
	database.DB.Create(&u)
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_v", "cus_v", "sub_v", "", "", 500)
	got := reload(t, u.ID)
	if got.SubscriptionPlan != "diamond" || got.SubscriptionExpiresAt == nil || got.SubscriptionExpiresAt.Before(time.Now().AddDate(0, 11, 0)) {
		t.Fatalf("value 500 should be diamond yearly: %+v", got)
	}
	if got.StorageLimit != 100*1024*1024*1024 {
		t.Fatalf("diamond storage: %d", got.StorageLimit)
	}
}

func TestHasAdFreeRules(t *testing.T) {
	now := time.Now()
	past := now.Add(-5 * 24 * time.Hour)
	recent := now.Add(-24 * time.Hour) // inside the renewal grace period
	cases := []struct {
		name string
		u    models.User
		want bool
	}{
		{"free account", models.User{SubscriptionPlan: "none", SubscriptionStatus: "inactive"}, false},
		{"lifetime", models.User{AdFreeLifetime: true}, true},
		{"admin", models.User{IsAdmin: true}, true},
		{"active silver", models.User{SubscriptionPlan: "silver", SubscriptionStatus: "active"}, true},
		{"inactive gold", models.User{SubscriptionPlan: "gold", SubscriptionStatus: "inactive"}, false},
		{"active but none", models.User{SubscriptionPlan: "none", SubscriptionStatus: "active"}, false},
		{"expired long ago", models.User{SubscriptionPlan: "silver", SubscriptionStatus: "active", SubscriptionExpiresAt: &past}, false},
		{"renewal pending", models.User{SubscriptionPlan: "silver", SubscriptionStatus: "active", SubscriptionExpiresAt: &recent}, true},
		{"lifetime with expired plan", models.User{AdFreeLifetime: true, SubscriptionPlan: "silver", SubscriptionStatus: "inactive"}, true},
	}
	for _, c := range cases {
		if got := c.u.HasAdFree(now); got != c.want {
			t.Errorf("%s: HasAdFree = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestMeExposesAdFree(t *testing.T) {
	app := setupPurchasesApp(t)
	free := models.User{Email: "free@example.com"}
	life := models.User{Email: "life@example.com", AdFreeLifetime: true}
	silver := models.User{Email: "silver@example.com", SubscriptionPlan: "silver", SubscriptionStatus: "active"}
	for _, u := range []*models.User{&free, &life, &silver} {
		database.DB.Create(u)
	}
	for _, c := range []struct {
		u        models.User
		adFree   bool
		lifetime bool
	}{{free, false, false}, {life, true, true}, {silver, true, false}} {
		code, out := call(t, app, createRomTestToken(c.u.ID), "GET", "/api/me", "")
		if code != 200 {
			t.Fatalf("me %s: %d", c.u.Email, code)
		}
		if out["ad_free"] != c.adFree || out["ad_free_lifetime"] != c.lifetime {
			t.Errorf("%s: ad_free=%v ad_free_lifetime=%v", c.u.Email, out["ad_free"], out["ad_free_lifetime"])
		}
	}
}

func TestAdFreeOfferPrice(t *testing.T) {
	app := setupPurchasesApp(t)
	code, out := call(t, app, "", "GET", "/api/purchases/ad-free", "")
	if code != 200 || out["price"] != 10.0 || out["one_time"] != true || out["currency"] != "BRL" {
		t.Fatalf("offer: %d %v", code, out)
	}
	t.Setenv("AD_FREE_PRICE", "12,50")
	if _, out := call(t, app, "", "GET", "/api/purchases/ad-free", ""); out["price"] != 12.5 {
		t.Fatalf("AD_FREE_PRICE override: %v", out["price"])
	}
}

// fakeAsaas records the requests the backend makes to Asaas.
type fakeAsaas struct {
	mu       sync.Mutex
	payments []map[string]any
	customer map[string]any
}

func (f *fakeAsaas) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]any{}
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/customers":
			f.customer = body
			_, _ = w.Write([]byte(`{"id":"cus_new"}`))
		case r.Method == "POST" && r.URL.Path == "/payments":
			f.payments = append(f.payments, body)
			id := "pay_" + strconv.Itoa(len(f.payments))
			_, _ = w.Write([]byte(`{"id":"` + id + `","status":"PENDING","invoiceUrl":"https://asaas.test/i/` + id + `","value":10}`))
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/pixQrCode"):
			_, _ = w.Write([]byte(`{"encodedImage":"IMG","payload":"PIXCODE"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestPurchaseAdFreeCreatesOneTimeCharge(t *testing.T) {
	app := setupPurchasesApp(t)
	fake := &fakeAsaas{}
	srv := fake.serve(t)
	old := payment.AsaasURL
	payment.AsaasURL = srv.URL
	t.Cleanup(func() { payment.AsaasURL = old })
	t.Setenv("ASAAS_API_KEY", "test-key")

	u := models.User{Email: "buyer@example.com", Name: "Comprador"}
	database.DB.Create(&u)
	tok := createRomTestToken(u.ID)

	// Unauthenticated
	if code, _ := call(t, app, "", "POST", "/api/purchases/ad-free", `{}`); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	// No CPF and no Asaas customer yet: the app must ask for it.
	code, out := call(t, app, tok, "POST", "/api/purchases/ad-free", `{}`)
	if code != 422 || out["code"] != "cpf_required" {
		t.Fatalf("missing cpf: %d %v", code, out)
	}

	code, out = call(t, app, tok, "POST", "/api/purchases/ad-free", `{"cpfCnpj":"52998224725","billingType":"PIX"}`)
	if code != 200 {
		t.Fatalf("purchase: %d %v", code, out)
	}
	if out["invoice_url"] != "https://asaas.test/i/pay_1" || out["pix_qrcode"] != "PIXCODE" || out["pix_image"] != "IMG" {
		t.Fatalf("purchase response: %v", out)
	}
	if len(fake.payments) != 1 {
		t.Fatalf("payments created: %d", len(fake.payments))
	}
	p := fake.payments[0]
	if p["externalReference"] != AdFreeExternalRef(u.ID) || p["value"] != 10.0 || p["customer"] != "cus_new" || p["billingType"] != "PIX" {
		t.Fatalf("charge sent to Asaas: %v", p)
	}
	if fake.customer["cpfCnpj"] != "52998224725" {
		t.Fatalf("customer sent to Asaas: %v", fake.customer)
	}
	got := reload(t, u.ID)
	if got.AsaasCustomerID != "cus_new" || got.CpfCnpj != "52998224725" {
		t.Fatalf("profile not saved: %+v", got)
	}
	if got.AdFreeLifetime {
		t.Fatal("pending charge must not grant before the webhook")
	}

	// Default billing type lets the payer choose on the Asaas page.
	if _, _ = call(t, app, tok, "POST", "/api/purchases/ad-free", `{}`); fake.payments[1]["billingType"] != "UNDEFINED" {
		t.Fatalf("default billing type: %v", fake.payments[1]["billingType"])
	}

	// Webhook confirms the charge, then buying again is refused.
	webhook(t, app, "PAYMENT_CONFIRMED", "pay_1", "cus_new", "", AdFreeExternalRef(u.ID), AdFreeDescription, 10)
	if code, out := call(t, app, tok, "POST", "/api/purchases/ad-free", `{}`); code != 409 || out["code"] != "already_ad_free" {
		t.Fatalf("second purchase: %d %v", code, out)
	}
}

func TestLegacyPlanPricesMigrateAndStorefrontListing(t *testing.T) {
	setupPurchasesApp(t)
	// A database seeded with the old defaults (and an admin-edited gold) ...
	database.DB.Model(&models.Plan{}).Where("tier = ?", "silver").Updates(map[string]any{"monthly_price": 9.99, "yearly_price": 99.90})
	database.DB.Model(&models.Plan{}).Where("tier = ?", "gold").Updates(map[string]any{"monthly_price": 27.0})
	database.DB.Model(&models.Plan{}).Where("tier = ?", "diamond").Updates(map[string]any{"monthly_price": 49.90, "is_secret": true})
	database.DB.Create(&models.Plan{Tier: "platina", Name: "Custom", MonthlyPrice: 70})
	SeedDefaultPlans()

	var silver, gold, diamond models.Plan
	database.DB.Where("tier = ?", "silver").First(&silver)
	database.DB.Where("tier = ?", "gold").First(&gold)
	database.DB.Where("tier = ?", "diamond").First(&diamond)
	if silver.MonthlyPrice != 15 || silver.YearlyPrice != 150 {
		t.Errorf("silver not migrated: %+v", silver)
	}
	if gold.MonthlyPrice != 27 {
		t.Errorf("admin-edited gold must be kept: %+v", gold)
	}
	if diamond.MonthlyPrice != 50 || diamond.IsSecret {
		t.Errorf("diamond not migrated/public: %+v", diamond)
	}

	app := fiber.New()
	app.Get("/api/plans", GetPlans)
	resp, _ := app.Test(httptest.NewRequest("GET", "/api/plans", nil))
	var list []models.Plan
	_ = json.NewDecoder(resp.Body).Decode(&list)
	tiers := []string{}
	for _, p := range list {
		tiers = append(tiers, p.Tier)
	}
	if strings.Join(tiers, ",") != "silver,gold,diamond" {
		t.Fatalf("storefront must list only the three cloud plans, got %v", tiers)
	}
}
