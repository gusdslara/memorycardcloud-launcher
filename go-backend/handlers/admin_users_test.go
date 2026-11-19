package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"golang.org/x/crypto/bcrypt"
)

func setupAdminUsersApp(t *testing.T) (*fiber.App, models.User) {
	t.Helper()
	setupRomsTestDB(t)
	if err := database.DB.AutoMigrate(&models.GameSave{}, &models.Game{}, &models.RefreshToken{}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ADMIN_EMAIL", "dono@example.com")
	t.Setenv("ADMIN_PASSWORD", "")
	t.Setenv("ASAAS_API_KEY", "")
	t.Setenv("DATA_DIR", t.TempDir())

	admin := models.User{Email: "dono@example.com", IsAdmin: true, SubscriptionPlan: "exclusive", SubscriptionStatus: "active"}
	database.DB.Create(&admin)

	app := fiber.New()
	app.Post("/api/login", Login)
	app.Post("/api/refresh", Refresh)
	g := app.Group("/api/admin", AuthMiddleware(), AdminMiddleware)
	g.Get("/users", AdminListUsers)
	g.Get("/users/stats", AdminUsersStats)
	g.Post("/users", AdminCreateUser)
	g.Get("/users/:id", AdminGetUser)
	g.Patch("/users/:id", AdminPatchUser)
	g.Delete("/users/:id", AdminDeleteUser)
	g.Post("/users/:id/password", AdminResetPassword)
	g.Post("/users/:id/sessions/revoke", AdminRevokeSessions)
	g.Delete("/users/:id/saves", AdminDeleteUserSaves)
	return app, admin
}

func call(t *testing.T, app *fiber.App, token, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req, 20000)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func login(t *testing.T, app *fiber.App, email, pw string) int {
	code, _ := call(t, app, "", "POST", "/api/login", `{"email":"`+email+`","password":"`+pw+`"}`)
	return code
}

func TestAdminCreateUserWithGeneratedPasswordAndFamily(t *testing.T) {
	app, admin := setupAdminUsersApp(t)
	tok := createRomTestToken(admin.ID)

	code, out := call(t, app, tok, "POST", "/api/admin/users", `{"email":"Esposa@Example.com","name":"Esposa","roms_access":true}`)
	if code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	pw, _ := out["password"].(string)
	if len(pw) != 14 {
		t.Fatalf("expected generated password xxxx-xxxx-xxxx, got %q", pw)
	}
	u := out["user"].(map[string]any)
	if u["subscription_plan"] != "diamond" || u["roms_access"] != true || u["email"] != "esposa@example.com" {
		t.Fatalf("family account should be Diamond with library: %v", u)
	}
	if got := login(t, app, "esposa@example.com", pw); got != 200 {
		t.Fatalf("login with generated password: %d", got)
	}
	if code, _ := call(t, app, tok, "POST", "/api/admin/users", `{"email":"esposa@example.com"}`); code != 409 {
		t.Errorf("duplicate e-mail: want 409, got %d", code)
	}
	if code, _ := call(t, app, tok, "POST", "/api/admin/users", `{"email":"x@example.com","password":"curta"}`); code != 400 {
		t.Errorf("short password: want 400, got %d", code)
	}
}

func TestAdminResetPasswordEndsSessions(t *testing.T) {
	app, admin := setupAdminUsersApp(t)
	tok := createRomTestToken(admin.ID)
	hash, _ := bcrypt.GenerateFromPassword([]byte("senha-antiga-123"), 4)
	u := models.User{Email: "joao@example.com", Password: string(hash), SubscriptionPlan: "none"}
	database.DB.Create(&u)
	database.DB.Create(&models.RefreshToken{UserID: u.ID, Token: "tok-joao", ExpiresAt: time.Now().Add(time.Hour)})

	code, out := call(t, app, tok, "POST", "/api/admin/users/"+strconv.Itoa(int(u.ID))+"/password", `{}`)
	if code != 200 {
		t.Fatalf("reset: %d %v", code, out)
	}
	if out["sessions_ended"].(float64) != 1 {
		t.Errorf("reset should end the open session: %v", out)
	}
	if got := login(t, app, "joao@example.com", "senha-antiga-123"); got == 200 {
		t.Error("old password still works")
	}
	if got := login(t, app, "joao@example.com", out["password"].(string)); got != 200 {
		t.Errorf("new password: want 200, got %d", got)
	}
	// chosen password
	code, out = call(t, app, tok, "POST", "/api/admin/users/"+strconv.Itoa(int(u.ID))+"/password", `{"password":"minha-senha-nova"}`)
	if code != 200 || out["password"] != nil {
		t.Fatalf("chosen password must not be echoed: %d %v", code, out)
	}
	if got := login(t, app, "joao@example.com", "minha-senha-nova"); got != 200 {
		t.Errorf("chosen password: want 200, got %d", got)
	}
}

func TestAdminSuspendBlocksLoginAndRefresh(t *testing.T) {
	app, admin := setupAdminUsersApp(t)
	tok := createRomTestToken(admin.ID)
	hash, _ := bcrypt.GenerateFromPassword([]byte("senha-1234"), 4)
	u := models.User{Email: "maria@example.com", Password: string(hash), SubscriptionPlan: "none"}
	database.DB.Create(&u)
	database.DB.Create(&models.RefreshToken{UserID: u.ID, Token: "tok-maria", ExpiresAt: time.Now().Add(time.Hour)})
	id := strconv.Itoa(int(u.ID))

	if code, out := call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"disabled":true,"disabled_reason":"teste"}`); code != 200 {
		t.Fatalf("suspend: %d %v", code, out)
	}
	if got := login(t, app, "maria@example.com", "senha-1234"); got != 403 {
		t.Errorf("suspended login: want 403, got %d", got)
	}
	var n int64
	database.DB.Model(&models.RefreshToken{}).Where("user_id = ?", u.ID).Count(&n)
	if n != 0 {
		t.Errorf("suspending should end sessions, %d left", n)
	}
	call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"disabled":false}`)
	if got := login(t, app, "maria@example.com", "senha-1234"); got != 200 {
		t.Errorf("reactivated login: want 200, got %d", got)
	}
	database.DB.First(&u, u.ID)
	if u.LastLoginAt == nil {
		t.Error("login should record last_login_at")
	}

	// self/owner protection
	self := strconv.Itoa(int(admin.ID))
	if code, _ := call(t, app, tok, "PATCH", "/api/admin/users/"+self, `{"disabled":true}`); code != 400 {
		t.Errorf("suspend self: want 400, got %d", code)
	}
	if code, _ := call(t, app, tok, "PATCH", "/api/admin/users/"+self, `{"is_admin":false}`); code != 400 {
		t.Errorf("demote self: want 400, got %d", code)
	}
	if code, _ := call(t, app, tok, "DELETE", "/api/admin/users/"+self, ``); code != 400 {
		t.Errorf("delete self: want 400, got %d", code)
	}
}

func TestAdminPatchPlanAndExpiry(t *testing.T) {
	app, admin := setupAdminUsersApp(t)
	tok := createRomTestToken(admin.ID)
	u := models.User{Email: "ana@example.com", SubscriptionPlan: "none", SubscriptionStatus: "inactive"}
	database.DB.Create(&u)
	id := strconv.Itoa(int(u.ID))

	code, out := call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"plan_tier":"silver","add_months":3}`)
	if code != 200 {
		t.Fatalf("plan: %d %v", code, out)
	}
	database.DB.First(&u, u.ID)
	if u.SubscriptionPlan != "silver" || u.SubscriptionStatus != "active" || u.SubscriptionExpiresAt == nil || u.RomsAccess {
		t.Fatalf("silver + 3 months: %+v", u)
	}
	if u.StorageLimit != 5*1024*1024*1024 {
		t.Errorf("silver storage: %d", u.StorageLimit)
	}
	// Diamond is the family plan: library comes with it, and leaves with it
	call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"plan_tier":"diamond"}`)
	u = models.User{} // GORM keeps old pointer values when scanning NULL into a used struct
	database.DB.First(&u, id)
	if !u.RomsAccess || u.SubscriptionExpiresAt != nil {
		t.Fatalf("diamond should grant the library without expiry: %+v", u)
	}
	call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"plan_tier":"gold","storage_limit":1073741824,"expires_at":"2030-01-31"}`)
	database.DB.First(&u, u.ID)
	if u.RomsAccess || u.StorageLimit != 1<<30 || u.SubscriptionExpiresAt.Year() != 2030 {
		t.Fatalf("gold with custom storage/expiry: %+v", u)
	}
	if code, _ := call(t, app, tok, "PATCH", "/api/admin/users/"+id, `{"plan_tier":"platina"}`); code != 400 {
		t.Errorf("unknown plan: want 400, got %d", code)
	}

	// list filters and stats
	code, out = call(t, app, tok, "GET", "/api/admin/users?plan=gold", ``)
	if code != 200 || out["total"].(float64) != 1 {
		t.Fatalf("filter by plan: %d %v", code, out)
	}
	_, out = call(t, app, tok, "GET", "/api/admin/users?q=ana&sort=usage", ``)
	if out["total"].(float64) != 1 {
		t.Fatalf("search: %v", out)
	}
	code, out = call(t, app, tok, "GET", "/api/admin/users/stats", ``)
	if code != 200 || out["total"].(float64) != 2 || out["admins"].(float64) != 1 {
		t.Fatalf("stats: %d %v", code, out)
	}
}

func TestAdminDeleteUserRemovesEverything(t *testing.T) {
	app, admin := setupAdminUsersApp(t)
	tok := createRomTestToken(admin.ID)
	u := models.User{Email: "sai@example.com", SubscriptionPlan: "silver", SubscriptionStatus: "active", AsaasSubscriptionID: "sub_123"}
	database.DB.Create(&u)
	dir := filepath.Join(os.Getenv("DATA_DIR"), "users", strconv.Itoa(int(u.ID)), "pc", "Jogo")
	os.MkdirAll(dir, 0o755)
	f := filepath.Join(dir, "save.zip")
	os.WriteFile(f, []byte("x"), 0o644)
	database.DB.Create(&models.GameSave{UserID: u.ID, GameName: "Jogo", Platform: "pc", Filename: f, Size: 1})
	database.DB.Create(&models.Game{UserID: u.ID, Name: "Jogo"})
	database.DB.Create(&models.RefreshToken{UserID: u.ID, Token: "tok-sai", ExpiresAt: time.Now().Add(time.Hour)})
	id := strconv.Itoa(int(u.ID))

	code, out := call(t, app, tok, "GET", "/api/admin/users/"+id, ``)
	if code != 200 || len(out["games"].([]any)) != 1 || len(out["sessions"].([]any)) != 1 {
		t.Fatalf("detail: %d %v", code, out)
	}
	code, out = call(t, app, tok, "DELETE", "/api/admin/users/"+id, ``)
	if code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	if w := out["warnings"].([]any); len(w) != 1 {
		t.Errorf("without ASAAS_API_KEY the panel must warn to cancel billing by hand: %v", w)
	}
	if _, err := os.Stat(f); !os.IsNotExist(err) {
		t.Error("save file left on disk")
	}
	for _, m := range []any{&models.User{}, &models.GameSave{}, &models.Game{}, &models.RefreshToken{}} {
		var n int64
		database.DB.Unscoped().Model(m).Where(map[bool]string{true: "id = ?", false: "user_id = ?"}[func() bool { _, ok := m.(*models.User); return ok }()], u.ID).Count(&n)
		if n != 0 {
			t.Errorf("%T left behind: %d", m, n)
		}
	}
	// e-mail is free again
	if code, _ := call(t, app, tok, "POST", "/api/admin/users", `{"email":"sai@example.com"}`); code != 201 {
		t.Errorf("recreate after delete: want 201, got %d", code)
	}
}
