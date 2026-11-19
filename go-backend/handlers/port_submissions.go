package handlers

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"go-backend/database"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// Community port submissions: users send a port/recomp from the app ("Enviar para aprovação"),
// the superadmin approves or rejects it, and approved ones are served publicly by
// GET /api/ports/community (merged into the app's catalog; curated ids always win).

const (
	portSubMaxBody         = 32 * 1024 // bytes of the request body
	portSubPostsPerHour    = 10
	portSubPostWindow      = time.Hour
	portSubMaxPendingUser  = 20
	portSubMineLimit       = 50
	portSubAdminListLimit  = 500
	portSubCommunityMaxAge = 300 // seconds (Cache-Control)
)

// Console categories accepted (same as ConsoleCategory in src/lib/types/ports.ts, without "All").
var portSubConsoles = map[string]bool{
	"Nintendo 64": true, "PlayStation 2": true, "PlayStation 1": true, "PlayStation 4": true,
	"GameCube / Wii": true, "Xbox 360": true, "PC / Retro": true, "Sega Genesis / CD": true,
	"Super Nintendo": true, "NES": true, "Game Boy / GBA": true, "Nintendo DS / 3DS": true,
	"PlayStation 3": true, "PlayStation Portable": true, "Arcade": true, "Xbox": true,
	"Nintendo Switch": true, "Wii U": true, "PlayStation 5": true, "Dreamcast / Saturn": true,
	"Outros": true,
}

var portSubTypes = map[string]bool{"recomp": true, "decomp": true, "source_port": true, "remake": true, "compat_layer": true}

var (
	portSubRepoRE = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)
	portSubSlugRE = regexp.MustCompile(`[^a-z0-9]+`)
	portSubHostRE = regexp.MustCompile(`^[a-z0-9.-]{1,253}$`)
)

// ---- payload (whitelisted PortItem fields) -------------------------------------------

type portSubRelease struct {
	Provider string            `json:"provider"`
	Repo     string            `json:"repo"`
	Host     string            `json:"host,omitempty"`
	Tag      string            `json:"tag,omitempty"`
	Assets   map[string]string `json:"assets"`
}

type portSubROM struct {
	FileType        string   `json:"fileType"`
	Extensions      []string `json:"extensions"`
	FileDescription string   `json:"fileDescription"`
	TargetFilename  string   `json:"targetFilename,omitempty"`
	Instructions    string   `json:"instructions"`
	HandledInApp    bool     `json:"handledInApp,omitempty"`
}

// PortSubmissionPayload is the subset of PortItem a submission may carry. Anything else is dropped.
type PortSubmissionPayload struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	ProjectName       string            `json:"projectName"`
	Console           string            `json:"console"`
	PortType          string            `json:"portType"`
	Description       string            `json:"description"`
	LongDescription   string            `json:"longDescription,omitempty"`
	Author            string            `json:"author"`
	WebsiteURL        string            `json:"websiteUrl,omitempty"`
	GithubRepo        string            `json:"githubRepo,omitempty"`
	SupportedOS       []string          `json:"supportedOs"`
	DownloadURLs      map[string]string `json:"downloadUrls"`
	ExecutableNames   map[string]string `json:"executableNames"`
	Release           *portSubRelease   `json:"release,omitempty"`
	DownloadPage      string            `json:"downloadPage,omitempty"`
	CompatibilityNote string            `json:"compatibilityNote,omitempty"`
	LaunchArgs        []string          `json:"launchArgs,omitempty"`
	RomRequirements   portSubROM        `json:"romRequirements"`
	CoverURL          string            `json:"coverUrl,omitempty"`
	Tags              []string          `json:"tags,omitempty"`
	Unofficial        bool              `json:"unofficial,omitempty"`
	Community         bool              `json:"community,omitempty"`
}

// portSubFieldError is a validation error tied to one form field (the app highlights it).
type portSubFieldError struct {
	Field string
	Msg   string
}

func (e *portSubFieldError) Error() string { return e.Msg }

func portSubErr(field, msg string) *portSubFieldError {
	return &portSubFieldError{Field: field, Msg: msg}
}

func portSubRunes(s string) int { return utf8.RuneCountInString(s) }

// slugifyPortID: "Ship of Harkinian!" → "ship-of-harkinian".
func slugifyPortID(s string) string {
	s = portSubSlugRE.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	s = strings.Trim(s, "-")
	if len(s) > 80 {
		s = strings.Trim(s[:80], "-")
	}
	return s
}

// normalizeGithubRepo accepts "owner/repo" or a github.com URL and returns "owner/repo".
func normalizeGithubRepo(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", true
	}
	low := strings.ToLower(s)
	for _, p := range []string{"https://www.github.com/", "http://www.github.com/", "https://github.com/", "http://github.com/", "www.github.com/", "github.com/"} {
		if strings.HasPrefix(low, p) {
			s = s[len(p):]
			break
		}
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	parts := strings.Split(s, "/")
	if len(parts) > 2 { // github.com/owner/repo/releases/... → owner/repo
		s = parts[0] + "/" + parts[1]
	}
	return s, portSubRepoRE.MatchString(s)
}

func portSubURL(s string) bool {
	if s == "" || len(s) > 500 {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// portSubRelPath: a file name or relative path inside the port folder (no "..", no absolute path).
func portSubRelPath(s string) bool {
	if s == "" || portSubRunes(s) > 160 || strings.ContainsAny(s, ":*?\"<>|") {
		return false
	}
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, "\\") {
		return false
	}
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return false
		}
	}
	return true
}

func portSubList(in []string, maxItems, maxLen int, field, what string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		if portSubRunes(v) > maxLen {
			return nil, portSubErr(field, what+": cada item com no máximo "+strconv.Itoa(maxLen)+" caracteres")
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) > maxItems {
		return nil, portSubErr(field, what+": no máximo "+strconv.Itoa(maxItems)+" itens")
	}
	return out, nil
}

// portSubLen: empty → "Informe <what>"; too short/long → "<Label>: ...".
func portSubLen(field, what, label, v string, min, max int) error {
	n := portSubRunes(v)
	if n == 0 {
		return portSubErr(field, "Informe "+what)
	}
	if n < min {
		return portSubErr(field, label+": pelo menos "+strconv.Itoa(min)+" caracteres")
	}
	if n > max {
		return portSubErr(field, label+": no máximo "+strconv.Itoa(max)+" caracteres")
	}
	return nil
}

// normalize validates and cleans the payload in place. Returns a *portSubFieldError on invalid input.
func (p *PortSubmissionPayload) normalize() error {
	p.Name = strings.TrimSpace(p.Name)
	p.ProjectName = strings.TrimSpace(p.ProjectName)
	p.Author = strings.TrimSpace(p.Author)
	p.Description = strings.TrimSpace(p.Description)
	p.LongDescription = strings.TrimSpace(p.LongDescription)
	p.Console = strings.TrimSpace(p.Console)
	p.PortType = strings.TrimSpace(p.PortType)
	p.WebsiteURL = strings.TrimSpace(p.WebsiteURL)
	p.DownloadPage = strings.TrimSpace(p.DownloadPage)
	p.CoverURL = strings.TrimSpace(p.CoverURL)
	p.CompatibilityNote = strings.TrimSpace(p.CompatibilityNote)
	p.Community = true

	if err := portSubLen("name", "o nome do port", "Nome do port", p.Name, 2, 120); err != nil {
		return err
	}
	if err := portSubLen("projectName", "o nome do jogo", "Nome do jogo", p.ProjectName, 1, 160); err != nil {
		return err
	}
	if err := portSubLen("author", "o autor ou equipe", "Autor", p.Author, 1, 120); err != nil {
		return err
	}
	if portSubRunes(p.Description) > 1000 {
		return portSubErr("description", "Descrição: no máximo 1000 caracteres")
	}
	if portSubRunes(p.LongDescription) > 4000 {
		return portSubErr("longDescription", "Descrição longa: no máximo 4000 caracteres")
	}
	if portSubRunes(p.CompatibilityNote) > 500 {
		return portSubErr("compatibilityNote", "Nota de compatibilidade: no máximo 500 caracteres")
	}
	if !portSubConsoles[p.Console] {
		return portSubErr("console", "Console inválido")
	}
	if !portSubTypes[p.PortType] {
		return portSubErr("portType", "Tipo de port inválido")
	}

	id := p.ID
	if strings.TrimSpace(id) == "" {
		id = p.Name
	}
	p.ID = slugifyPortID(id)
	if len(p.ID) < 2 {
		return portSubErr("id", "ID inválido: use letras e números")
	}

	repo, ok := normalizeGithubRepo(p.GithubRepo)
	if !ok {
		return portSubErr("githubRepo", "Repositório do GitHub inválido (use usuario/repositorio)")
	}
	p.GithubRepo = repo

	for field, v := range map[string]string{"websiteUrl": p.WebsiteURL, "downloadPage": p.DownloadPage, "coverUrl": p.CoverURL} {
		if v != "" && !portSubURL(v) {
			return portSubErr(field, "Link inválido (use http:// ou https://)")
		}
	}

	// platforms
	oss := []string{}
	seen := map[string]bool{}
	for _, os := range p.SupportedOS {
		os = strings.ToLower(strings.TrimSpace(os))
		if os == "" || seen[os] {
			continue
		}
		if !reviewPlatforms[os] {
			return portSubErr("supportedOs", "Plataforma inválida: "+os)
		}
		seen[os] = true
		oss = append(oss, os)
	}
	if len(oss) == 0 {
		return portSubErr("supportedOs", "Escolha pelo menos uma plataforma")
	}
	p.SupportedOS = oss

	cleanMap := func(in map[string]string, field string, check func(string) bool, msg string) (map[string]string, error) {
		out := map[string]string{}
		for k, v := range in {
			k = strings.ToLower(strings.TrimSpace(k))
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if !reviewPlatforms[k] {
				return nil, portSubErr(field, "Plataforma inválida: "+k)
			}
			if !check(v) {
				return nil, portSubErr(field, msg)
			}
			out[k] = v
		}
		return out, nil
	}
	var err error
	if p.DownloadURLs, err = cleanMap(p.DownloadURLs, "downloadUrl", portSubURL, "URL de download inválida (use http:// ou https://)"); err != nil {
		return err
	}
	if p.ExecutableNames, err = cleanMap(p.ExecutableNames, "executableName", portSubRelPath, "Nome do executável inválido (sem caminho absoluto ou \"..\")"); err != nil {
		return err
	}

	if r := p.Release; r != nil {
		r.Provider = strings.ToLower(strings.TrimSpace(r.Provider))
		r.Host = strings.ToLower(strings.TrimSpace(r.Host))
		r.Tag = strings.TrimSpace(r.Tag)
		if r.Provider != "github" && r.Provider != "gitea" {
			return portSubErr("release", "Release: provedor deve ser github ou gitea")
		}
		if rr, ok := normalizeGithubRepo(r.Repo); !ok || rr == "" {
			return portSubErr("release", "Release: repositório inválido")
		} else {
			r.Repo = rr
		}
		if r.Provider == "github" {
			r.Host = ""
		} else if r.Host != "" && !portSubHostRE.MatchString(r.Host) {
			return portSubErr("release", "Release: host inválido")
		}
		if portSubRunes(r.Tag) > 100 {
			return portSubErr("release", "Release: tag muito longa")
		}
		if r.Assets, err = cleanMap(r.Assets, "release", func(v string) bool { return portSubRunes(v) <= 200 }, "Release: padrão de arquivo muito longo"); err != nil {
			return err
		}
		if len(r.Assets) == 0 {
			p.Release = nil
		}
	}

	if p.GithubRepo == "" && len(p.DownloadURLs) == 0 && p.Release == nil && p.DownloadPage == "" {
		return portSubErr("downloadUrl", "Informe o repositório do GitHub ou um link de download")
	}

	if p.LaunchArgs, err = portSubList(p.LaunchArgs, 20, 200, "launchArgs", "Argumentos"); err != nil {
		return err
	}
	if p.Tags, err = portSubList(p.Tags, 10, 30, "tags", "Tags"); err != nil {
		return err
	}

	rom := &p.RomRequirements
	rom.FileType = strings.TrimSpace(rom.FileType)
	if rom.FileType == "" {
		rom.FileType = "file"
	}
	if rom.FileType != "file" && rom.FileType != "folder" {
		return portSubErr("romFileType", "Tipo de entrada inválido")
	}
	if rom.Extensions, err = portSubList(rom.Extensions, 20, 40, "romExtensions", "Extensões"); err != nil {
		return err
	}
	rom.FileDescription = strings.TrimSpace(rom.FileDescription)
	rom.Instructions = strings.TrimSpace(rom.Instructions)
	rom.TargetFilename = strings.TrimSpace(rom.TargetFilename)
	if portSubRunes(rom.FileDescription) > 200 {
		return portSubErr("romDescription", "Descrição da ROM: no máximo 200 caracteres")
	}
	if portSubRunes(rom.Instructions) > 1000 {
		return portSubErr("romInstructions", "Instruções: no máximo 1000 caracteres")
	}
	if rom.TargetFilename != "" && !portSubRelPath(rom.TargetFilename) {
		return portSubErr("targetFilename", "Nome final da ROM inválido")
	}
	return nil
}

// ---- helpers -----------------------------------------------------------------------

// portSubView is what the API returns for a submission. Admin views also carry the submitter and payload.
type portSubView struct {
	ID              uint            `json:"id"`
	Status          string          `json:"status"`
	PortID          string          `json:"portId"`
	Name            string          `json:"name"`
	ProjectName     string          `json:"projectName"`
	Console         string          `json:"console"`
	GithubRepo      string          `json:"githubRepo"`
	RejectReason    string          `json:"rejectReason,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	ReviewedAt      *time.Time      `json:"reviewedAt,omitempty"`
	UserID          uint            `json:"userId,omitempty"`
	UserEmail       string          `json:"userEmail,omitempty"`
	UserName        string          `json:"userName,omitempty"`
	ReviewedByEmail string          `json:"reviewedByEmail,omitempty"`
	Payload         json.RawMessage `json:"payload,omitempty"`
}

func portSubViewOf(s *models.PortSubmission, admin bool) portSubView {
	v := portSubView{
		ID: s.ID, Status: s.Status, PortID: s.PortID, Name: s.Name, ProjectName: s.ProjectName,
		Console: s.Console, GithubRepo: s.GithubRepo, RejectReason: s.RejectReason,
		CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt, ReviewedAt: s.ReviewedAt,
	}
	if admin {
		v.UserID, v.UserEmail, v.UserName, v.ReviewedByEmail = s.UserID, s.UserEmail, s.UserName, s.ReviewedByEmail
		v.Payload = json.RawMessage(s.Payload)
	} else if s.Status != models.PortSubmissionPending {
		// the author sees what was published (an admin may have edited it)
		v.Payload = json.RawMessage(s.Payload)
	}
	return v
}

func portSubApply(s *models.PortSubmission, p *PortSubmissionPayload) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	s.Payload = string(b)
	s.PortID, s.Name, s.ProjectName, s.Console, s.GithubRepo = p.ID, p.Name, p.ProjectName, p.Console, p.GithubRepo
	return nil
}

// catalogConflict reports whether the curated catalog already has this repo (→ name) and whether the id is taken.
func catalogConflict(p *PortSubmissionPayload) (repoName string, idTaken bool) {
	cat, err := reviewCatalog()
	if err != nil || cat == nil {
		return "", false
	}
	idTaken = cat.Get(p.ID) != nil
	if p.GithubRepo == "" {
		return "", idTaken
	}
	for _, it := range cat.Items {
		if it.Kind != "port" {
			continue
		}
		repo := it.GithubRepo
		if repo == "" && it.Release != nil {
			repo = it.Release.Repo
		}
		if repo != "" && strings.EqualFold(repo, p.GithubRepo) {
			return it.Name, idTaken
		}
	}
	return "", idTaken
}

// dupQuery matches submissions of the same project: same GitHub repo, or (no repo) same game + name.
func portSubDupQuery(db *gorm.DB, p *PortSubmissionPayload) *gorm.DB {
	if p.GithubRepo != "" {
		return db.Where("LOWER(github_repo) = ?", strings.ToLower(p.GithubRepo))
	}
	return db.Where("LOWER(project_name) = ? AND LOWER(name) = ?", strings.ToLower(p.ProjectName), strings.ToLower(p.Name))
}

var portSubLimiter = struct {
	sync.Mutex
	hits map[uint][]time.Time
}{hits: map[uint][]time.Time{}}

func allowPortSubmission(userID uint, now time.Time) bool {
	portSubLimiter.Lock()
	defer portSubLimiter.Unlock()
	cutoff := now.Add(-portSubPostWindow)
	kept := portSubLimiter.hits[userID][:0]
	for _, t := range portSubLimiter.hits[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= portSubPostsPerHour {
		portSubLimiter.hits[userID] = kept
		return false
	}
	portSubLimiter.hits[userID] = append(kept, now)
	return true
}

func portSubBadField(c *fiber.Ctx, err error) error {
	var fe *portSubFieldError
	if errors.As(err, &fe) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": fe.Msg, "field": fe.Field})
	}
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Dados inválidos"})
}

// ---- community catalog cache ----------------------------------------------------------

var portSubCommunityCache struct {
	sync.Mutex
	body []byte
	etag string
}

func invalidateCommunityPorts() {
	portSubCommunityCache.Lock()
	portSubCommunityCache.body, portSubCommunityCache.etag = nil, ""
	portSubCommunityCache.Unlock()
}

// ---- user endpoints --------------------------------------------------------------------

// CreatePortSubmission: POST /api/ports/submissions (auth). Body: a PortItem.
// The same user sending the same project again while it is pending updates that submission.
func CreatePortSubmission(c *fiber.Ctx) error {
	user, err := reviewUser(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Faça login para enviar ports"})
	}
	if user.Disabled {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": "Conta suspensa"})
	}
	if len(c.Body()) > portSubMaxBody {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"message": "Envio grande demais (máximo 32 KB)"})
	}
	var p PortSubmissionPayload
	if err := json.Unmarshal(c.Body(), &p); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "JSON inválido"})
	}
	if err := p.normalize(); err != nil {
		return portSubBadField(c, err)
	}
	if name, idTaken := catalogConflict(&p); name != "" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "Este projeto já está no catálogo oficial (" + name + ").", "field": "githubRepo"})
	} else if idTaken {
		p.ID = slugifyPortID("community-" + p.ID)
	}

	db := database.DB
	var approved int64
	if err := portSubDupQuery(db.Model(&models.PortSubmission{}), &p).Where("status = ?", models.PortSubmissionApproved).Count(&approved).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
	}
	if approved > 0 {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "Este projeto já foi aprovado e está no catálogo da comunidade."})
	}
	var pending models.PortSubmission
	found := portSubDupQuery(db, &p).Where("status = ?", models.PortSubmissionPending).Order("id").Limit(1).Find(&pending)
	if found.Error != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
	}
	if found.RowsAffected > 0 && pending.UserID != user.ID {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "Alguém já enviou este projeto e ele está em análise."})
	}
	if !allowPortSubmission(user.ID, time.Now()) {
		c.Set(fiber.HeaderRetryAfter, "3600")
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"message": "Muitos envios em pouco tempo. Tente de novo mais tarde."})
	}

	if found.RowsAffected > 0 { // own pending submission: replace it
		if err := portSubApply(&pending, &p); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
		}
		if err := db.Save(&pending).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"submission": portSubViewOf(&pending, false), "updated": true})
	}

	var mine int64
	db.Model(&models.PortSubmission{}).Where("user_id = ? AND status = ?", user.ID, models.PortSubmissionPending).Count(&mine)
	if mine >= portSubMaxPendingUser {
		return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"message": "Você já tem muitos envios em análise. Aguarde a revisão."})
	}

	sub := models.PortSubmission{UserID: user.ID, UserEmail: user.Email, UserName: user.Name, Status: models.PortSubmissionPending}
	if err := portSubApply(&sub, &p); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
	}
	if err := db.Create(&sub).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao enviar"})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"submission": portSubViewOf(&sub, false), "updated": false})
}

// MyPortSubmissions: GET /api/ports/submissions/mine (auth). Newest first.
func MyPortSubmissions(c *fiber.Ctx) error {
	user, err := reviewUser(c)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Faça login"})
	}
	var rows []models.PortSubmission
	if err := database.DB.Where("user_id = ?", user.ID).Order("created_at DESC, id DESC").Limit(portSubMineLimit).Find(&rows).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar envios"})
	}
	out := make([]portSubView, 0, len(rows))
	for i := range rows {
		out = append(out, portSubViewOf(&rows[i], false))
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"items": out})
}

// GetCommunityPorts: GET /api/ports/community (public). Approved submissions as PortItem[].
func GetCommunityPorts(c *fiber.Ctx) error {
	portSubCommunityCache.Lock()
	if portSubCommunityCache.body == nil {
		var rows []models.PortSubmission
		if err := database.DB.Select("id", "payload", "port_id").Where("status = ?", models.PortSubmissionApproved).
			Order("id").Find(&rows).Error; err != nil {
			portSubCommunityCache.Unlock()
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar ports da comunidade"})
		}
		items := make([]json.RawMessage, 0, len(rows))
		seen := map[string]bool{}
		for _, r := range rows {
			if seen[r.PortID] || !json.Valid([]byte(r.Payload)) {
				continue
			}
			seen[r.PortID] = true
			items = append(items, json.RawMessage(r.Payload))
		}
		body, _ := json.Marshal(items)
		sum := sha1.Sum(body)
		portSubCommunityCache.body, portSubCommunityCache.etag = body, `W/"`+hex.EncodeToString(sum[:8])+`"`
	}
	body, etag := portSubCommunityCache.body, portSubCommunityCache.etag
	portSubCommunityCache.Unlock()

	c.Set(fiber.HeaderCacheControl, "public, max-age="+strconv.Itoa(portSubCommunityMaxAge))
	c.Set(fiber.HeaderETag, etag)
	if match := c.Get(fiber.HeaderIfNoneMatch); match != "" && match == etag {
		return c.SendStatus(fiber.StatusNotModified)
	}
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSONCharsetUTF8)
	return c.Send(body)
}

// ---- admin endpoints -------------------------------------------------------------------

// AdminListPortSubmissions: GET /api/admin/ports/submissions?status=pending|approved|rejected|all
func AdminListPortSubmissions(c *fiber.Ctx) error {
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	q := database.DB.Model(&models.PortSubmission{})
	switch status {
	case "", "all":
	case models.PortSubmissionPending, models.PortSubmissionApproved, models.PortSubmissionRejected:
		q = q.Where("status = ?", status)
	default:
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "status inválido"})
	}
	var rows []models.PortSubmission
	if err := q.Order("created_at DESC, id DESC").Limit(portSubAdminListLimit).Find(&rows).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao carregar envios"})
	}
	type countRow struct {
		Status string
		N      int64
	}
	var counts []countRow
	database.DB.Model(&models.PortSubmission{}).Select("status, COUNT(*) AS n").Group("status").Scan(&counts)
	totals := fiber.Map{"pending": int64(0), "approved": int64(0), "rejected": int64(0), "total": int64(0)}
	var total int64
	for _, r := range counts {
		totals[r.Status] = r.N
		total += r.N
	}
	totals["total"] = total

	out := make([]portSubView, 0, len(rows))
	for i := range rows {
		out = append(out, portSubViewOf(&rows[i], true))
	}
	// pending first (oldest pending first = review queue order), then the rest newest first
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := out[i].Status == models.PortSubmissionPending, out[j].Status == models.PortSubmissionPending
		if pi != pj {
			return pi
		}
		if pi {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return false
	})
	return c.JSON(fiber.Map{"items": out, "counts": totals})
}

func portSubLoad(c *fiber.Ctx) (*models.PortSubmission, error) {
	id, err := strconv.ParseUint(c.Params("id"), 10, 64)
	if err != nil {
		return nil, c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "ID inválido"})
	}
	var s models.PortSubmission
	if r := database.DB.Limit(1).Find(&s, id); r.Error != nil || r.RowsAffected == 0 {
		return nil, c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Envio não encontrado"})
	}
	return &s, nil
}

func portSubMarkReviewed(c *fiber.Ctx, s *models.PortSubmission) {
	now := time.Now()
	s.ReviewedAt = &now
	if admin, err := reviewUser(c); err == nil {
		id := admin.ID
		s.ReviewedBy = &id
		s.ReviewedByEmail = admin.Email
	}
}

// AdminApprovePortSubmission: POST /api/admin/ports/submissions/:id/approve
// Optional body {"payload": {...PortItem}} replaces the submitted port (edit-then-approve).
func AdminApprovePortSubmission(c *fiber.Ctx) error {
	s, err := portSubLoad(c)
	if s == nil {
		return err
	}
	if len(c.Body()) > portSubMaxBody {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"message": "Envio grande demais (máximo 32 KB)"})
	}
	var body struct {
		Payload json.RawMessage `json:"payload"`
	}
	if len(c.Body()) > 0 {
		if err := json.Unmarshal(c.Body(), &body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "JSON inválido"})
		}
	}
	raw := []byte(s.Payload)
	if len(body.Payload) > 0 && string(body.Payload) != "null" {
		raw = body.Payload
	}
	var p PortSubmissionPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Payload inválido"})
	}
	if err := p.normalize(); err != nil {
		return portSubBadField(c, err)
	}
	if _, idTaken := catalogConflict(&p); idTaken {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "O id \"" + p.ID + "\" já existe no catálogo oficial. Edite o id antes de aprovar.", "field": "id"})
	}
	var clash int64
	database.DB.Model(&models.PortSubmission{}).Where("status = ? AND port_id = ? AND id <> ?", models.PortSubmissionApproved, p.ID, s.ID).Count(&clash)
	if clash > 0 {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": "Já existe um port da comunidade aprovado com o id \"" + p.ID + "\". Edite o id.", "field": "id"})
	}
	if err := portSubApply(s, &p); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao aprovar"})
	}
	s.Status = models.PortSubmissionApproved
	s.RejectReason = ""
	portSubMarkReviewed(c, s)
	if err := database.DB.Save(s).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao aprovar"})
	}
	invalidateCommunityPorts()
	return c.JSON(portSubViewOf(s, true))
}

// AdminRejectPortSubmission: POST /api/admin/ports/submissions/:id/reject {"reason": "..."}
// Also unpublishes an approved submission.
func AdminRejectPortSubmission(c *fiber.Ctx) error {
	s, err := portSubLoad(c)
	if s == nil {
		return err
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Dados inválidos"})
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if portSubRunes(body.Reason) < 3 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Diga o motivo da recusa (o autor vê esse texto).", "field": "reason"})
	}
	if portSubRunes(body.Reason) > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Motivo: no máximo 500 caracteres", "field": "reason"})
	}
	wasApproved := s.Status == models.PortSubmissionApproved
	s.Status = models.PortSubmissionRejected
	s.RejectReason = body.Reason
	portSubMarkReviewed(c, s)
	if err := database.DB.Save(s).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao recusar"})
	}
	if wasApproved {
		invalidateCommunityPorts()
	}
	return c.JSON(portSubViewOf(s, true))
}

// AdminDeletePortSubmission: DELETE /api/admin/ports/submissions/:id
func AdminDeletePortSubmission(c *fiber.Ctx) error {
	s, err := portSubLoad(c)
	if s == nil {
		return err
	}
	if err := database.DB.Delete(s).Error; err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Erro ao apagar"})
	}
	if s.Status == models.PortSubmissionApproved {
		invalidateCommunityPorts()
	}
	return c.JSON(fiber.Map{"ok": true, "id": s.ID})
}
