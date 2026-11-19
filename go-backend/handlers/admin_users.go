package handlers

// Superadmin user management: list/filter, create, edit plan and family access, reset password,
// end sessions, suspend, delete cloud saves and delete the account.

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/payment"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

const adminBcryptCost = 12

// callerID is the logged superadmin (set by AuthMiddleware).
func callerID(c *fiber.Ctx) uint {
	tok, ok := c.Locals("user").(*jwt.Token)
	if !ok {
		return 0
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return 0
	}
	switch v := claims["sub"].(type) {
	case float64:
		return uint(v)
	case string:
		n, _ := strconv.Atoi(v)
		return uint(n)
	}
	return 0
}

// isOwnerAccount: the account of ADMIN_EMAIL. It is recreated as superadmin on every start, so it
// cannot be deleted, suspended or demoted from the panel.
func isOwnerAccount(u *models.User) bool {
	owner := os.Getenv("ADMIN_EMAIL")
	return owner != "" && strings.EqualFold(strings.TrimSpace(owner), u.Email)
}

// generatePassword: 3 groups of 4 without look-alike characters (0/O, 1/l/I), ~70 bits.
func generatePassword() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	var b strings.Builder
	for i := 0; i < 12; i++ {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			panic(err)
		}
		b.WriteByte(alphabet[n.Int64()])
	}
	return b.String()
}

func hashPassword(pw string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pw), adminBcryptCost)
	return string(h), err
}

func revokeSessions(userID uint) int64 {
	res := database.DB.Where("user_id = ?", userID).Delete(&models.RefreshToken{})
	return res.RowsAffected
}

// adminUserRow is what the panel sees of an account (includes private fields /me never returns).
type adminUserRow struct {
	ID                    uint       `json:"id"`
	Email                 string     `json:"email"`
	Name                  string     `json:"name"`
	MobilePhone           string     `json:"mobile_phone"`
	CpfCnpj               string     `json:"cpf_cnpj"`
	CreatedAt             time.Time  `json:"created_at"`
	SubscriptionStatus    string     `json:"subscription_status"`
	SubscriptionPlan      string     `json:"subscription_plan"`
	SubscriptionExpiresAt *time.Time `json:"subscription_expires_at"`
	Expired               bool       `json:"expired"`
	StorageLimit          int64      `json:"storage_limit"`
	PlanStorageLimit      int64      `json:"plan_storage_limit"`
	UsageBytes            int64      `json:"usage_bytes"`
	SavesCount            int64      `json:"saves_count"`
	Sessions              int64      `json:"sessions"`
	IsAdmin               bool       `json:"is_admin"`
	RomsAccess            bool       `json:"roms_access"`
	Disabled              bool       `json:"disabled"`
	DisabledReason        string     `json:"disabled_reason"`
	AdminNote             string     `json:"admin_note"`
	LastLoginAt           *time.Time `json:"last_login_at"`
	LastSeenAt            *time.Time `json:"last_seen_at"`
	AsaasCustomerID       string     `json:"asaas_customer_id"`
	AsaasSubscriptionID   string     `json:"asaas_subscription_id"`
	TermsAccepted         bool       `json:"terms_accepted"`
	AdFreeLifetime        bool       `json:"ad_free_lifetime"` // bought (or was given) "Sem anúncios para sempre"
	AdFree                bool       `json:"ad_free"`          // lifetime, cloud plan or admin
	Owner                 bool       `json:"owner"`            // ADMIN_EMAIL account
	Self                  bool       `json:"self"`             // the superadmin looking at the panel
}

func toAdminRow(u *models.User, self uint) adminUserRow {
	now := time.Now()
	return adminUserRow{
		ID: u.ID, Email: u.Email, Name: u.Name, MobilePhone: u.MobilePhone, CpfCnpj: u.CpfCnpj, CreatedAt: u.CreatedAt,
		SubscriptionStatus: u.SubscriptionStatus, SubscriptionPlan: u.SubscriptionPlan, SubscriptionExpiresAt: u.SubscriptionExpiresAt,
		Expired:      u.SubscriptionExpiresAt != nil && u.SubscriptionExpiresAt.Before(now) && u.SubscriptionPlan != "none",
		StorageLimit: u.StorageLimit, PlanStorageLimit: planStorage(u.SubscriptionPlan),
		IsAdmin: u.IsAdmin, RomsAccess: u.RomsAccess, Disabled: u.Disabled, DisabledReason: u.DisabledReason, AdminNote: u.AdminNote,
		LastLoginAt: u.LastLoginAt, LastSeenAt: u.LastSeenAt, AsaasCustomerID: u.AsaasCustomerID, AsaasSubscriptionID: u.AsaasSubscriptionID,
		TermsAccepted: u.TermsAccepted, AdFreeLifetime: u.AdFreeLifetime, AdFree: u.HasAdFree(now), Owner: isOwnerAccount(u), Self: self != 0 && u.ID == self,
	}
}

func planStorage(tier string) int64 {
	if tier == "" || strings.EqualFold(tier, "none") {
		return models.GetPlanStorageLimit("free")
	}
	return models.GetPlanStorageLimit(tier)
}

// fillUsage adds saves size/count and open sessions to the rows (2 grouped queries).
func fillUsage(rows []adminUserRow) {
	if len(rows) == 0 {
		return
	}
	ids := make([]uint, len(rows))
	idx := make(map[uint]int, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
		idx[r.ID] = i
	}
	var usage []struct {
		UserID uint
		Bytes  int64
		Count  int64
	}
	database.DB.Model(&models.GameSave{}).Select("user_id, COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count").
		Where("user_id IN ?", ids).Group("user_id").Scan(&usage)
	for _, u := range usage {
		rows[idx[u.UserID]].UsageBytes, rows[idx[u.UserID]].SavesCount = u.Bytes, u.Count
	}
	var sess []struct {
		UserID uint
		Count  int64
	}
	database.DB.Model(&models.RefreshToken{}).Select("user_id, COUNT(*) AS count").
		Where("user_id IN ? AND revoked = ? AND expires_at > ?", ids, false, time.Now()).Group("user_id").Scan(&sess)
	for _, s := range sess {
		rows[idx[s.UserID]].Sessions = s.Count
	}
}

const usageExpr = "(SELECT COALESCE(SUM(size),0) FROM game_saves WHERE game_saves.user_id = users.id AND game_saves.deleted_at IS NULL)"

// AdminListUsers GET /api/admin/users?q&plan&status&filter&sort&page&limit
//
//	plan:   tier | none
//	status: active | inactive | expired
//	filter: family | admin | disabled | paying | new
//	sort:   recent | oldest | name | usage | seen | expires
func AdminListUsers(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "25"))
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 25
	}
	now := time.Now()

	db := database.DB.Model(&models.User{})
	if q := strings.ToLower(strings.TrimSpace(c.Query("q"))); q != "" {
		like := "%" + q + "%"
		if id, err := strconv.Atoi(q); err == nil {
			db = db.Where("id = ? OR LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR mobile_phone LIKE ? OR cpf_cnpj LIKE ?", id, like, like, like, like)
		} else {
			db = db.Where("LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR mobile_phone LIKE ? OR cpf_cnpj LIKE ?", like, like, like, like)
		}
	}
	if plan := strings.ToLower(strings.TrimSpace(c.Query("plan"))); plan != "" {
		if plan == "none" {
			db = db.Where("subscription_plan IS NULL OR subscription_plan = '' OR LOWER(subscription_plan) = 'none'")
		} else {
			db = db.Where("LOWER(subscription_plan) = ?", plan)
		}
	}
	switch c.Query("status") {
	case "active":
		db = db.Where("subscription_status = 'active' AND (subscription_expires_at IS NULL OR subscription_expires_at > ?)", now)
	case "inactive":
		db = db.Where("subscription_status <> 'active' OR subscription_status IS NULL")
	case "expired":
		db = db.Where("subscription_expires_at IS NOT NULL AND subscription_expires_at <= ? AND LOWER(subscription_plan) <> 'none'", now)
	}
	switch c.Query("filter") {
	case "family":
		db = db.Where("roms_access = ? AND is_admin = ?", true, false)
	case "admin":
		db = db.Where("is_admin = ?", true)
	case "disabled":
		db = db.Where("disabled = ?", true)
	case "paying":
		db = db.Where("asaas_subscription_id <> '' AND asaas_subscription_id IS NOT NULL")
	case "new":
		db = db.Where("created_at > ?", now.AddDate(0, 0, -30))
	}

	var total int64
	db.Count(&total)

	switch c.Query("sort") {
	case "oldest":
		db = db.Order("id ASC")
	case "name":
		db = db.Order("LOWER(COALESCE(NULLIF(name,''), email))")
	case "usage":
		db = db.Order(usageExpr + " DESC").Order("id DESC")
	case "seen":
		db = db.Order("last_seen_at IS NULL").Order("last_seen_at DESC")
	case "expires":
		db = db.Order("subscription_expires_at IS NULL").Order("subscription_expires_at ASC")
	default:
		db = db.Order("id DESC")
	}

	var users []models.User
	db.Limit(limit).Offset((page - 1) * limit).Find(&users)
	self := callerID(c)
	rows := make([]adminUserRow, len(users))
	for i := range users {
		rows[i] = toAdminRow(&users[i], self)
	}
	fillUsage(rows)

	lastPage := int((total + int64(limit) - 1) / int64(limit))
	return c.JSON(fiber.Map{"users": rows, "total": total, "page": page, "limit": limit, "last_page": lastPage})
}

// AdminUsersStats GET /api/admin/users/stats: counts for the summary cards.
func AdminUsersStats(c *fiber.Ctx) error {
	now := time.Now()
	count := func(where string, args ...interface{}) int64 {
		var n int64
		database.DB.Model(&models.User{}).Where(where, args...).Count(&n)
		return n
	}
	var total int64
	database.DB.Model(&models.User{}).Count(&total)

	var byPlan []struct {
		Plan  string `json:"plan"`
		Count int64  `json:"count"`
	}
	database.DB.Model(&models.User{}).Select("LOWER(COALESCE(NULLIF(subscription_plan,''),'none')) AS plan, COUNT(*) AS count").
		Group("LOWER(COALESCE(NULLIF(subscription_plan,''),'none'))").Order("count DESC").Scan(&byPlan)

	var saves struct {
		Bytes int64
		Files int64
	}
	database.DB.Model(&models.GameSave{}).Select("COALESCE(SUM(size),0) AS bytes, COUNT(*) AS files").Scan(&saves)

	return c.JSON(fiber.Map{
		"total":       total,
		"active":      count("subscription_status = 'active' AND is_admin = ? AND (subscription_expires_at IS NULL OR subscription_expires_at > ?)", false, now),
		"paying":      count("asaas_subscription_id <> '' AND asaas_subscription_id IS NOT NULL"),
		"family":      count("roms_access = ? AND is_admin = ?", true, false),
		"admins":      count("is_admin = ?", true),
		"disabled":    count("disabled = ?", true),
		"expired":     count("subscription_expires_at IS NOT NULL AND subscription_expires_at <= ? AND LOWER(subscription_plan) <> 'none'", now),
		"new_30d":     count("created_at > ?", now.AddDate(0, 0, -30)),
		"seen_7d":     count("last_seen_at > ?", now.AddDate(0, 0, -7)),
		"by_plan":     byPlan,
		"saves_bytes": saves.Bytes,
		"saves_files": saves.Files,
	})
}

func findUser(c *fiber.Ctx) (*models.User, error) {
	var u models.User
	if err := database.DB.First(&u, "id = ?", c.Params("id")).Error; err != nil {
		return nil, c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Conta não encontrada"})
	}
	return &u, nil
}

// AdminGetUser GET /api/admin/users/:id: account + saves per game + open sessions.
func AdminGetUser(c *fiber.Ctx) error {
	u, err := findUser(c)
	if u == nil {
		return err
	}
	rows := []adminUserRow{toAdminRow(u, callerID(c))}
	fillUsage(rows)

	var games []struct {
		GameName string `json:"game_name"`
		Platform string `json:"platform"`
		Count    int64  `json:"count"`
		Bytes    int64  `json:"bytes"`
		Last     int64  `json:"last"`
	}
	database.DB.Model(&models.GameSave{}).Where("user_id = ?", u.ID).
		Select("game_name, platform, COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes, MAX(CASE WHEN timestamp > 0 THEN timestamp ELSE CAST(strftime('%s', created_at) AS INTEGER) END) AS last").
		Group("game_name, platform").Order("last DESC").Limit(200).Scan(&games)

	var sessions []models.RefreshToken
	database.DB.Where("user_id = ? AND revoked = ? AND expires_at > ?", u.ID, false, time.Now()).Order("created_at DESC").Limit(20).Find(&sessions)
	sess := make([]fiber.Map, len(sessions))
	for i, s := range sessions {
		sess[i] = fiber.Map{"id": s.ID, "created_at": s.CreatedAt, "expires_at": s.ExpiresAt}
	}
	return c.JSON(fiber.Map{"user": rows[0], "games": games, "sessions": sess})
}

type adminCreateUserReq struct {
	Email      string `json:"email"`
	Name       string `json:"name"`
	Password   string `json:"password"`
	PlanTier   string `json:"plan_tier"`
	ExpiresAt  string `json:"expires_at"` // YYYY-MM-DD, empty = no expiry
	RomsAccess bool   `json:"roms_access"`
	IsAdmin    bool   `json:"is_admin"`
	AdminNote  string `json:"admin_note"`
}

// AdminCreateUser POST /api/admin/users: creates an account (e.g. for the family). Empty password =
// generated one, returned once.
func AdminCreateUser(c *fiber.Ctx) error {
	var req adminCreateUserReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Pedido inválido"})
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t") {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "E-mail inválido"})
	}
	var n int64
	database.DB.Unscoped().Model(&models.User{}).Where("LOWER(email) = ?", email).Count(&n)
	if n > 0 {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "Já existe uma conta com esse e-mail"})
	}
	pw, generated := strings.TrimSpace(req.Password), false
	if pw == "" {
		pw, generated = generatePassword(), true
	} else if len(pw) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "A senha precisa ter pelo menos 8 caracteres"})
	}
	hash, err := hashPassword(pw)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível gerar a senha"})
	}
	u := models.User{
		Email: email, Name: strings.TrimSpace(req.Name), Password: hash, IsAdmin: req.IsAdmin,
		SubscriptionPlan: "none", SubscriptionStatus: "inactive", StorageLimit: models.GetPlanStorageLimit("free"),
		AdminNote: strings.TrimSpace(req.AdminNote),
	}
	if msg := applyPlan(&u, req.PlanTier); msg != "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": msg})
	}
	if req.RomsAccess {
		applyFamilyAccess(&u, true)
	}
	if req.ExpiresAt != "" && u.SubscriptionPlan != "none" {
		t, err := parseExpiry(req.ExpiresAt)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Data de validade inválida"})
		}
		u.SubscriptionExpiresAt = t
	}
	if err := database.DB.Create(&u).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível criar a conta"})
	}
	out := fiber.Map{"user": toAdminRow(&u, callerID(c))}
	if generated {
		out["password"] = pw
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}

// applyPlan sets plan, status and storage from the plan table. The family library follows the plan
// (Diamond/Exclusive have it). Empty tier = unchanged.
func applyPlan(u *models.User, tier string) string {
	tier = strings.ToLower(strings.TrimSpace(tier))
	if tier == "" {
		return ""
	}
	if tier == "none" {
		u.SubscriptionPlan, u.SubscriptionStatus, u.SubscriptionExpiresAt = "none", "inactive", nil
		u.StorageLimit = models.GetPlanStorageLimit("free")
		u.RomsAccess = false
		return ""
	}
	var p models.Plan
	if err := database.DB.Where("LOWER(tier) = ?", tier).First(&p).Error; err != nil {
		return "Plano não existe: " + tier
	}
	if !strings.EqualFold(u.SubscriptionPlan, p.Tier) {
		u.SubscriptionExpiresAt = nil // a new plan starts without the old expiry
	}
	u.SubscriptionPlan, u.SubscriptionStatus = p.Tier, "active"
	u.StorageLimit = models.GetPlanStorageLimit(p.Tier)
	u.RomsAccess = p.HasRomsAccess
	return ""
}

// parseExpiry: YYYY-MM-DD → end of that day (UTC-safe: 23:59:59 local server time).
func parseExpiry(s string) (*time.Time, error) {
	t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(s), time.Local)
	if err != nil {
		return nil, err
	}
	t = t.Add(24*time.Hour - time.Second)
	return &t, nil
}

type adminPatchUserReq struct {
	Name           *string `json:"name"`
	Email          *string `json:"email"`
	MobilePhone    *string `json:"mobile_phone"`
	AdminNote      *string `json:"admin_note"`
	PlanTier       *string `json:"plan_tier"`
	Status         *string `json:"subscription_status"` // active | inactive
	ExpiresAt      *string `json:"expires_at"`          // "" = no expiry, YYYY-MM-DD
	AddMonths      int     `json:"add_months"`          // extends from the current expiry (or today)
	StorageLimit   *int64  `json:"storage_limit"`       // bytes; 0 = plan default
	IsAdmin        *bool   `json:"is_admin"`
	RomsAccess     *bool   `json:"roms_access"`
	Disabled       *bool   `json:"disabled"`
	DisabledReason *string `json:"disabled_reason"`
	AdFreeLifetime *bool   `json:"ad_free_lifetime"` // "Sem anúncios para sempre" granted/removed by hand
}

// AdminPatchUser PATCH /api/admin/users/:id
func AdminPatchUser(c *fiber.Ctx) error {
	u, ferr := findUser(c)
	if u == nil {
		return ferr
	}
	var req adminPatchUserReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Pedido inválido"})
	}
	self := callerID(c)
	protected := isOwnerAccount(u) || u.ID == self
	bad := func(msg string) error { return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": msg}) }

	if req.Name != nil {
		u.Name = strings.TrimSpace(*req.Name)
	}
	if req.AdminNote != nil {
		u.AdminNote = strings.TrimSpace(*req.AdminNote)
	}
	if req.MobilePhone != nil {
		phone := strings.TrimSpace(*req.MobilePhone)
		if phone != "" && phone != u.MobilePhone {
			var n int64
			database.DB.Model(&models.User{}).Where("mobile_phone = ? AND id <> ?", phone, u.ID).Count(&n)
			if n > 0 {
				return bad("Esse telefone já está em outra conta")
			}
		}
		u.MobilePhone = phone
	}
	if req.Email != nil {
		email := strings.ToLower(strings.TrimSpace(*req.Email))
		if email != u.Email {
			if isOwnerAccount(u) {
				return bad("O e-mail do dono vem do ADMIN_EMAIL do servidor: troque lá")
			}
			if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t") {
				return bad("E-mail inválido")
			}
			var n int64
			database.DB.Unscoped().Model(&models.User{}).Where("LOWER(email) = ? AND id <> ?", email, u.ID).Count(&n)
			if n > 0 {
				return bad("Já existe uma conta com esse e-mail")
			}
			u.Email = email
		}
	}

	if req.PlanTier != nil {
		if isOwnerAccount(u) && !strings.EqualFold(*req.PlanTier, "exclusive") {
			return bad("A conta do dono fica sempre no plano Exclusive")
		}
		if msg := applyPlan(u, *req.PlanTier); msg != "" {
			return bad(msg)
		}
	}
	if req.RomsAccess != nil && *req.RomsAccess != u.RomsAccess {
		applyFamilyAccess(u, *req.RomsAccess)
	}
	if req.AdFreeLifetime != nil && *req.AdFreeLifetime != u.AdFreeLifetime {
		u.AdFreeLifetime = *req.AdFreeLifetime
		if u.AdFreeLifetime {
			now := time.Now()
			u.AdFreeSince, u.AdFreePaymentID = &now, "admin"
		} else {
			u.AdFreeSince, u.AdFreePaymentID = nil, ""
		}
	}
	if req.Status != nil {
		switch *req.Status {
		case "active", "inactive":
			if *req.Status == "active" && (u.SubscriptionPlan == "" || u.SubscriptionPlan == "none") {
				return bad("Escolha um plano antes de ativar a assinatura")
			}
			u.SubscriptionStatus = *req.Status
		default:
			return bad("Status inválido")
		}
	}
	if req.ExpiresAt != nil {
		if *req.ExpiresAt == "" {
			u.SubscriptionExpiresAt = nil
		} else {
			t, err := parseExpiry(*req.ExpiresAt)
			if err != nil {
				return bad("Data de validade inválida")
			}
			u.SubscriptionExpiresAt = t
			if t.After(time.Now()) && u.SubscriptionPlan != "none" {
				u.SubscriptionStatus = "active"
			}
		}
	}
	if req.AddMonths != 0 {
		if req.AddMonths < -120 || req.AddMonths > 120 {
			return bad("Meses fora do intervalo")
		}
		if u.SubscriptionPlan == "" || u.SubscriptionPlan == "none" {
			return bad("Escolha um plano antes de dar meses")
		}
		base := time.Now()
		if u.SubscriptionExpiresAt != nil && u.SubscriptionExpiresAt.After(base) {
			base = *u.SubscriptionExpiresAt
		}
		t := base.AddDate(0, req.AddMonths, 0)
		u.SubscriptionExpiresAt = &t
		if t.After(time.Now()) {
			u.SubscriptionStatus = "active"
		}
	}
	if req.StorageLimit != nil {
		if *req.StorageLimit < 0 {
			return bad("Espaço inválido")
		}
		if *req.StorageLimit == 0 {
			u.StorageLimit = planStorage(u.SubscriptionPlan)
		} else {
			u.StorageLimit = *req.StorageLimit
		}
	}
	if req.IsAdmin != nil && *req.IsAdmin != u.IsAdmin {
		if protected && !*req.IsAdmin {
			return bad("Você não pode tirar o superadmin da sua própria conta nem da conta do dono")
		}
		u.IsAdmin = *req.IsAdmin
	}
	revoke := false
	if req.Disabled != nil && *req.Disabled != u.Disabled {
		if protected && *req.Disabled {
			return bad("Você não pode suspender a sua própria conta nem a do dono")
		}
		u.Disabled = *req.Disabled
		if u.Disabled {
			revoke = true
		} else {
			u.DisabledReason = ""
		}
	}
	if req.DisabledReason != nil && u.Disabled {
		u.DisabledReason = strings.TrimSpace(*req.DisabledReason)
	}

	if err := database.DB.Save(u).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível salvar"})
	}
	if revoke {
		revokeSessions(u.ID)
	}
	rows := []adminUserRow{toAdminRow(u, self)}
	fillUsage(rows)
	return c.JSON(fiber.Map{"user": rows[0]})
}

// AdminResetPassword POST /api/admin/users/:id/password {password?, keep_sessions?}
// Empty password = a new one is generated and returned once. Ends the account's sessions.
func AdminResetPassword(c *fiber.Ctx) error {
	u, ferr := findUser(c)
	if u == nil {
		return ferr
	}
	var req struct {
		Password     string `json:"password"`
		KeepSessions bool   `json:"keep_sessions"`
	}
	_ = c.BodyParser(&req)
	if isOwnerAccount(u) && os.Getenv("ADMIN_PASSWORD") != "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "A senha do dono vem do ADMIN_PASSWORD do servidor e volta a ela no próximo reinício: troque lá"})
	}
	pw, generated := strings.TrimSpace(req.Password), false
	if pw == "" {
		pw, generated = generatePassword(), true
	} else if len(pw) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "A senha precisa ter pelo menos 8 caracteres"})
	}
	hash, err := hashPassword(pw)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível gerar a senha"})
	}
	database.DB.Model(&models.User{}).Where("id = ?", u.ID).UpdateColumn("password", hash)
	var ended int64
	if !req.KeepSessions {
		ended = revokeSessions(u.ID)
	}
	out := fiber.Map{"message": "Senha trocada", "sessions_ended": ended}
	if generated {
		out["password"] = pw
	}
	return c.JSON(out)
}

// AdminRevokeSessions POST /api/admin/users/:id/sessions/revoke: logs the account out everywhere
// (the current access token still works for up to 15 minutes).
func AdminRevokeSessions(c *fiber.Ctx) error {
	u, ferr := findUser(c)
	if u == nil {
		return ferr
	}
	return c.JSON(fiber.Map{"sessions_ended": revokeSessions(u.ID)})
}

// deleteUserSaves removes the save files and rows of the account.
func deleteUserSaves(userID uint) (files int64, bytes int64) {
	var saves []models.GameSave
	database.DB.Unscoped().Where("user_id = ?", userID).Find(&saves)
	for _, s := range saves {
		if s.Filename != "" {
			if err := os.Remove(s.Filename); err == nil {
				files++
			}
		}
		bytes += s.Size
	}
	database.DB.Unscoped().Where("user_id = ?", userID).Delete(&models.GameSave{})
	if userID > 0 {
		id := strconv.FormatUint(uint64(userID), 10)
		for _, base := range []string{os.Getenv("DATA_DIR"), "./uploads"} {
			if base == "" {
				continue
			}
			dir := filepath.Join(base, "users", id)
			if filepath.Base(dir) == id && filepath.Base(filepath.Dir(dir)) == "users" {
				_ = os.RemoveAll(dir)
			}
		}
	}
	return files, bytes
}

// AdminDeleteUserSaves DELETE /api/admin/users/:id/saves
func AdminDeleteUserSaves(c *fiber.Ctx) error {
	u, ferr := findUser(c)
	if u == nil {
		return ferr
	}
	var n int64
	database.DB.Model(&models.GameSave{}).Where("user_id = ?", u.ID).Count(&n)
	_, bytes := deleteUserSaves(u.ID)
	return c.JSON(fiber.Map{"deleted": n, "bytes": bytes})
}

// AdminDeleteUser DELETE /api/admin/users/:id?cancel_billing=1
// Permanently removes the account, its cloud saves, games and sessions. Optionally cancels the
// Asaas subscription so it stops charging.
func AdminDeleteUser(c *fiber.Ctx) error {
	u, ferr := findUser(c)
	if u == nil {
		return ferr
	}
	if u.ID == callerID(c) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Você não pode apagar a sua própria conta por aqui"})
	}
	if isOwnerAccount(u) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "A conta do dono (ADMIN_EMAIL) não pode ser apagada"})
	}
	warnings := []string{}
	if u.AsaasSubscriptionID != "" && c.Query("cancel_billing") != "0" {
		if key := os.Getenv("ASAAS_API_KEY"); key == "" {
			warnings = append(warnings, "ASAAS_API_KEY não configurada: cancele a assinatura no painel do Asaas")
		} else if err := payment.NewAsaasClient(key).DeleteSubscription(u.AsaasSubscriptionID); err != nil {
			warnings = append(warnings, fmt.Sprintf("Não foi possível cancelar a assinatura no Asaas (%v): cancele no painel", err))
		}
	}
	files, bytes := deleteUserSaves(u.ID)
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Where("user_id = ?", u.ID).Delete(&models.Game{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", u.ID).Delete(&models.RefreshToken{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&models.User{}, u.ID).Error
	})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível apagar a conta"})
	}
	return c.JSON(fiber.Map{"message": "Conta apagada", "files": files, "bytes": bytes, "warnings": warnings})
}
