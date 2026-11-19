package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"go-backend/database"
	"go-backend/internal/catalog"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

// Player reviews ("avaliações") of catalog ports: our own users' reviews plus
// reports imported from RecompLauncher (see reviews_import.go).

const (
	reviewMaxHardware   = 300
	reviewMaxNote       = 500
	reviewMaxVersion    = 64
	reviewMaxFPS        = 1000
	reviewListDefault   = 50
	reviewListMax       = 100
	reviewSummaryTTL    = 10 * time.Minute
	reviewPostsPerHour  = 20
	reviewPostWindow    = time.Hour
	reviewDefaultAuthor = "Jogador"
)

var reviewPlatforms = map[string]bool{"windows": true, "linux": true, "macos": true, "android": true, "ios": true}

// ---- catalog used to validate port ids -------------------------------------

var (
	reviewCatMu  sync.Mutex
	reviewCat    *catalog.Catalog
	reviewCatErr error
)

// reviewCatalog returns the catalog (CATALOG_PATH or the embedded catalog.json), loaded once.
func reviewCatalog() (*catalog.Catalog, error) {
	reviewCatMu.Lock()
	defer reviewCatMu.Unlock()
	if reviewCat == nil && reviewCatErr == nil {
		reviewCat, reviewCatErr = catalog.Load(os.Getenv("CATALOG_PATH"))
		if reviewCatErr != nil {
			log.Printf("[reviews] catálogo indisponível: %v", reviewCatErr)
		}
	}
	return reviewCat, reviewCatErr
}

// SetReviewCatalog replaces the catalog used by the reviews endpoints and importer (tests).
func SetReviewCatalog(c *catalog.Catalog) {
	reviewCatMu.Lock()
	reviewCat, reviewCatErr = c, nil
	reviewCatMu.Unlock()
	invalidateReviewSummaries()
}

func isReviewablePort(id string) bool {
	cat, err := reviewCatalog()
	return err == nil && cat.IsPort(id)
}

// ---- summary -----------------------------------------------------------------

// ReviewSummary aggregates every visible review of a port.
type ReviewSummary struct {
	Total       int            `json:"total"`
	Runs        int            `json:"runs"`
	Issues      int            `json:"issues"`
	Broken      int            `json:"broken"`
	AvgRating   *float64       `json:"avgRating"`
	RatingCount int            `json:"ratingCount"`
	AvgFPS      *float64       `json:"avgFps"`
	StutterYes  int            `json:"stutterYes"`
	StutterNo   int            `json:"stutterNo"`
	Sources     map[string]int `json:"sources"`
	// Platforms counts reviews per platform (windows, linux, macos, android, ios; "" = not informed).
	Platforms map[string]int `json:"platforms"`
	// Devices is the number of distinct devices (hardware descriptions) that reported.
	Devices int `json:"devices"`

	ratingSum int64
	fpsSum    int64
	fpsCount  int
}

func newReviewSummary() *ReviewSummary {
	return &ReviewSummary{
		Sources:   map[string]int{models.ReviewSourceMemoryCard: 0, models.ReviewSourceRecompLauncher: 0},
		Platforms: map[string]int{},
	}
}

// reviewAggRow is one (port, source, verdict) group of the aggregate query.
type reviewAggRow struct {
	PortID     string `gorm:"column:port_id"`
	Source     string `gorm:"column:source"`
	Verdict    string `gorm:"column:verdict"`
	N          int    `gorm:"column:n"`
	RatingSum  int64  `gorm:"column:rating_sum"`
	RatingN    int    `gorm:"column:rating_n"`
	FPSSum     int64  `gorm:"column:fps_sum"`
	FPSN       int    `gorm:"column:fps_n"`
	StutterYes int    `gorm:"column:stutter_yes"`
	StutterNo  int    `gorm:"column:stutter_no"`
}

func (s *ReviewSummary) add(r reviewAggRow) {
	s.Total += r.N
	switch r.Verdict {
	case "runs":
		s.Runs += r.N
	case "issues":
		s.Issues += r.N
	case "broken":
		s.Broken += r.N
	}
	s.Sources[r.Source] += r.N
	s.ratingSum += r.RatingSum
	s.RatingCount += r.RatingN
	s.fpsSum += r.FPSSum
	s.fpsCount += r.FPSN
	s.StutterYes += r.StutterYes
	s.StutterNo += r.StutterNo
}

func roundTo(v float64, decimals int) float64 {
	p := math.Pow(10, float64(decimals))
	return math.Round(v*p) / p
}

func (s *ReviewSummary) finish() {
	s.AvgRating, s.AvgFPS = nil, nil
	if s.RatingCount > 0 {
		v := roundTo(float64(s.ratingSum)/float64(s.RatingCount), 2)
		s.AvgRating = &v
	}
	if s.fpsCount > 0 {
		v := roundTo(float64(s.fpsSum)/float64(s.fpsCount), 1)
		s.AvgFPS = &v
	}
}

// buildReviewSummaries merges aggregate rows into one summary per port.
func buildReviewSummaries(rows []reviewAggRow) map[string]*ReviewSummary {
	out := map[string]*ReviewSummary{}
	for _, r := range rows {
		s := out[r.PortID]
		if s == nil {
			s = newReviewSummary()
			out[r.PortID] = s
		}
		s.add(r)
	}
	for _, s := range out {
		s.finish()
	}
	return out
}

// queryReviewSummaries aggregates visible reviews in SQL (all ports when portID is empty).
func queryReviewSummaries(db *gorm.DB, portID string, source ...string) (map[string]*ReviewSummary, error) {
	q := db.Model(&models.PortReview{}).
		Select(`port_id, source, verdict, COUNT(*) AS n,
			COALESCE(SUM(rating), 0) AS rating_sum, COUNT(rating) AS rating_n,
			COALESCE(SUM(fps), 0) AS fps_sum, COUNT(fps) AS fps_n,
			COALESCE(SUM(CASE WHEN stutter = 1 THEN 1 ELSE 0 END), 0) AS stutter_yes,
			COALESCE(SUM(CASE WHEN stutter = 0 THEN 1 ELSE 0 END), 0) AS stutter_no`).
		Where("hidden = ?", false).
		Group("port_id, source, verdict")
	if portID != "" {
		q = q.Where("port_id = ?", portID)
	}
	if len(source) > 0 && source[0] != "" {
		q = q.Where("source = ?", source[0])
	}
	var rows []reviewAggRow
	if err := q.Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := buildReviewSummaries(rows)

	// platforms and distinct devices ("roda no meu aparelho"): same filters, separate groupings
	filter := func(q *gorm.DB) *gorm.DB {
		q = q.Where("hidden = ?", false)
		if portID != "" {
			q = q.Where("port_id = ?", portID)
		}
		if len(source) > 0 && source[0] != "" {
			q = q.Where("source = ?", source[0])
		}
		return q
	}
	var plats []struct {
		PortID   string `gorm:"column:port_id"`
		Platform string `gorm:"column:platform"`
		N        int    `gorm:"column:n"`
	}
	if err := filter(db.Model(&models.PortReview{})).Select("port_id, platform, COUNT(*) AS n").Group("port_id, platform").Scan(&plats).Error; err != nil {
		return nil, err
	}
	for _, r := range plats {
		if s := out[r.PortID]; s != nil {
			s.Platforms[r.Platform] += r.N
		}
	}
	var devs []struct {
		PortID string `gorm:"column:port_id"`
		N      int    `gorm:"column:n"`
	}
	if err := filter(db.Model(&models.PortReview{})).Where("hardware <> ''").
		Select("port_id, COUNT(DISTINCT LOWER(hardware)) AS n").Group("port_id").Scan(&devs).Error; err != nil {
		return nil, err
	}
	for _, r := range devs {
		if s := out[r.PortID]; s != nil {
			s.Devices = r.N
		}
	}
	return out, nil
}

type cachedSummary struct {
	at   time.Time
	body []byte
}

// One cached body per ?source= ("" = all sources).
var reviewSummaryCache struct {
	sync.Mutex
	bySource map[string]cachedSummary
}

func invalidateReviewSummaries() {
	reviewSummaryCache.Lock()
	reviewSummaryCache.bySource = nil
	reviewSummaryCache.Unlock()
	invalidatePublicSummaries()
}

// GetReviewSummaries: GET /api/reviews/summary[?source=memorycard] (public). Every port with ≥1 review.
// The catalog builder asks only for source=memorycard: it already counts RecompLauncher reports itself.
func GetReviewSummaries(c *fiber.Ctx) error {
	source := c.Query("source")
	if source != "" && source != models.ReviewSourceMemoryCard && source != models.ReviewSourceRecompLauncher {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "source inválido"})
	}
	reviewSummaryCache.Lock()
	defer reviewSummaryCache.Unlock()
	if reviewSummaryCache.bySource == nil {
		reviewSummaryCache.bySource = map[string]cachedSummary{}
	}
	cached := reviewSummaryCache.bySource[source]
	if cached.body == nil || time.Since(cached.at) > reviewSummaryTTL {
		sums, err := queryReviewSummaries(database.DB, "", source)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
		}
		body, err := json.Marshal(fiber.Map{"ports": sums})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
		}
		cached = cachedSummary{at: time.Now(), body: body}
		reviewSummaryCache.bySource[source] = cached
	}
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSONCharsetUTF8)
	c.Set(fiber.HeaderCacheControl, "public, max-age=300")
	return c.Send(cached.body)
}

// ---- list ----------------------------------------------------------------------

// GetReviews: GET /api/reviews?port=<id>&limit=50&offset=0 (public).
func GetReviews(c *fiber.Ctx) error {
	portID := strings.TrimSpace(c.Query("port"))
	if portID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Informe o port (?port=<id>)"})
	}
	if !isReviewablePort(portID) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Port não encontrado no catálogo"})
	}
	limit := c.QueryInt("limit", reviewListDefault)
	if limit < 1 {
		limit = reviewListDefault
	}
	if limit > reviewListMax {
		limit = reviewListMax
	}
	offset := c.QueryInt("offset", 0)
	if offset < 0 {
		offset = 0
	}

	sums, err := queryReviewSummaries(database.DB, portID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
	}
	summary := sums[portID]
	if summary == nil {
		summary = newReviewSummary()
	}
	items := []models.PortReview{}
	if err := database.DB.Where("port_id = ? AND hidden = ?", portID, false).
		Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&items).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar avaliações"})
	}
	return c.JSON(fiber.Map{"port": portID, "summary": summary, "items": items})
}

// ---- create / update -------------------------------------------------------------

type reviewInput struct {
	Port     string `json:"port"`
	Platform string `json:"platform"`
	Version  string `json:"version"`
	Hardware string `json:"hardware"`
	Rating   *int   `json:"rating"`
	FPS      *int   `json:"fps"`
	Stutter  *bool  `json:"stutter"`
	Note     string `json:"note"`
}

// verdictForRating: 4–5 → runs, 2–3 → issues, 1 → broken.
func verdictForRating(r int) string {
	switch {
	case r >= 4:
		return "runs"
	case r >= 2:
		return "issues"
	default:
		return "broken"
	}
}

// reviewAuthorName: "Gustavo Lima Souza" → "Gustavo S."; never the e-mail.
func reviewAuthorName(name string) string {
	if strings.Contains(name, "@") {
		return reviewDefaultAuthor
	}
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return reviewDefaultAuthor
	}
	first := truncateRunes(parts[0], 40)
	if len(parts) == 1 {
		return first
	}
	last, _ := utf8.DecodeRuneInString(parts[len(parts)-1])
	if last == utf8.RuneError || !unicode.IsLetter(last) {
		return first
	}
	return first + " " + string(unicode.ToUpper(last)) + "."
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}

// validate checks and normalizes the input; returns a pt-BR message on error.
func (in *reviewInput) validate() string {
	in.Port = strings.TrimSpace(in.Port)
	in.Platform = strings.ToLower(strings.TrimSpace(in.Platform))
	in.Version = strings.TrimSpace(in.Version)
	in.Hardware = strings.TrimSpace(in.Hardware)
	in.Note = strings.TrimSpace(in.Note)
	switch {
	case in.Port == "":
		return "Informe o port"
	case !isReviewablePort(in.Port):
		return "Port não encontrado no catálogo"
	case !reviewPlatforms[in.Platform]:
		return "Plataforma inválida (windows, linux, macos, android ou ios)"
	case in.Hardware == "":
		return "Informe o seu hardware"
	case utf8.RuneCountInString(in.Hardware) > reviewMaxHardware:
		return "Hardware: no máximo 300 caracteres"
	case utf8.RuneCountInString(in.Version) > reviewMaxVersion:
		return "Versão: no máximo 64 caracteres"
	case in.Rating == nil || *in.Rating < 1 || *in.Rating > 5:
		return "Nota obrigatória, de 1 a 5"
	case in.FPS != nil && (*in.FPS < 1 || *in.FPS > reviewMaxFPS):
		return "FPS deve estar entre 1 e 1000"
	case utf8.RuneCountInString(in.Note) > reviewMaxNote:
		return "Comentário: no máximo 500 caracteres"
	}
	return ""
}

// in-memory per-user rate limit for POST /api/reviews
var reviewPostLimiter = struct {
	sync.Mutex
	hits map[uint][]time.Time
}{hits: map[uint][]time.Time{}}

// Per-IP limit on top of the per-user one: new accounts from the same address cannot flood a port.
const reviewPostsPerHourIP = 40

var reviewPostIPLimiter = struct {
	sync.Mutex
	hits map[string][]time.Time
}{hits: map[string][]time.Time{}}

func allowReviewPostIP(ip string, now time.Time) bool {
	if ip == "" {
		return true
	}
	reviewPostIPLimiter.Lock()
	defer reviewPostIPLimiter.Unlock()
	cutoff := now.Add(-reviewPostWindow)
	kept := reviewPostIPLimiter.hits[ip][:0]
	for _, t := range reviewPostIPLimiter.hits[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= reviewPostsPerHourIP {
		reviewPostIPLimiter.hits[ip] = kept
		return false
	}
	reviewPostIPLimiter.hits[ip] = append(kept, now)
	if len(reviewPostIPLimiter.hits) > 50000 { // memória limitada: esquece IPs antigos
		for k, v := range reviewPostIPLimiter.hits {
			if len(v) == 0 || v[len(v)-1].Before(cutoff) {
				delete(reviewPostIPLimiter.hits, k)
			}
		}
	}
	return true
}

func allowReviewPost(userID uint, now time.Time) bool {
	reviewPostLimiter.Lock()
	defer reviewPostLimiter.Unlock()
	cutoff := now.Add(-reviewPostWindow)
	kept := reviewPostLimiter.hits[userID][:0]
	for _, t := range reviewPostLimiter.hits[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= reviewPostsPerHour {
		reviewPostLimiter.hits[userID] = kept
		return false
	}
	reviewPostLimiter.hits[userID] = append(kept, now)
	return true
}

// reviewUser loads the authenticated user (set by AuthMiddleware).
func reviewUser(c *fiber.Ctx) (*models.User, error) {
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

// CreateReview: POST /api/reviews (auth). One review per (user, port, platform); posting again replaces it.
func CreateReview(c *fiber.Ctx) error {
	user, err := reviewUser(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Faça login para avaliar"})
	}
	if user.Disabled {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": "Conta suspensa"})
	}
	var in reviewInput
	if err := c.BodyParser(&in); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Dados inválidos"})
	}
	if msg := in.validate(); msg != "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": msg})
	}
	if !allowReviewPostIP(reviewClientIP(c), time.Now()) || !allowReviewPost(user.ID, time.Now()) {
		c.Set(fiber.HeaderRetryAfter, "3600")
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"message": "Muitas avaliações em pouco tempo. Tente de novo mais tarde."})
	}

	uid := user.ID
	rating := *in.Rating
	var review models.PortReview
	found := database.DB.Where("user_id = ? AND port_id = ? AND platform = ? AND source = ?",
		uid, in.Port, in.Platform, models.ReviewSourceMemoryCard).Limit(1).Find(&review)
	if found.Error != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao salvar avaliação"})
	}
	created := found.RowsAffected == 0
	review.PortID = in.Port
	review.Source = models.ReviewSourceMemoryCard
	review.UserID = &uid
	review.Author = reviewAuthorName(user.Name)
	review.Hardware = in.Hardware
	review.Platform = in.Platform
	review.Version = in.Version
	review.Rating = &rating
	review.Verdict = verdictForRating(rating)
	review.FPS = in.FPS
	review.Stutter = in.Stutter
	review.Note = in.Note
	review.Hidden = false
	if err := database.DB.Save(&review).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao salvar avaliação"})
	}
	invalidateReviewSummaries()
	status := fiber.StatusOK
	if created {
		status = fiber.StatusCreated
	}
	return c.Status(status).JSON(review)
}

// DeleteReview: DELETE /api/reviews/:id (auth). The author or an admin.
// Imported reports are hidden instead of deleted, so the importer does not re-add them.
func DeleteReview(c *fiber.Ctx) error {
	user, err := reviewUser(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Faça login"})
	}
	id, err := strconv.ParseUint(c.Params("id"), 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "ID inválido"})
	}
	var review models.PortReview
	if r := database.DB.Limit(1).Find(&review, id); r.Error != nil || r.RowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Avaliação não encontrada"})
	}
	owner := review.UserID != nil && *review.UserID == user.ID
	if !owner && !user.IsAdmin {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": "Você só pode remover as suas avaliações"})
	}
	if review.ExternalKey != nil {
		err = database.DB.Model(&review).Update("hidden", true).Error
	} else {
		err = database.DB.Delete(&review).Error
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao remover avaliação"})
	}
	invalidateReviewSummaries()
	return c.JSON(fiber.Map{"ok": true, "id": review.ID})
}

// reviewClientIP: the address Caddy saw (last X-Forwarded-For hop; earlier ones can be forged by the client).
func reviewClientIP(c *fiber.Ctx) string {
	if xff := c.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	return c.IP()
}
