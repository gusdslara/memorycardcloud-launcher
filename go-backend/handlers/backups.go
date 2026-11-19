package handlers

// Cloud backups of the users on the owner's Google Drive (internal/backupstore).
//
//	GET    /api/backups/usage                 quota of the plan, used, reserved, grace period
//	GET    /api/backups                       list (same as GET /api/saves)
//	POST   /api/backups/uploads               {file_name,size,game_name,platform,kind,hash,timestamp} → reserve + session
//	GET    /api/backups/uploads/:id           {received,size} to resume
//	PUT    /api/backups/uploads/:id           raw chunk, header Upload-Offset
//	POST   /api/backups/uploads/:id/complete  → the backup (status queued|stored)
//	DELETE /api/backups/uploads/:id           cancel and release the reservation
//	GET    /api/backups/:id/link              {url} signed for 10 min → GET /api/backup-file/:token
//	GET    /api/admin/backups/stats           capacity, overcommit, dedup, queue, Drive budget
//	POST   /api/admin/backups/janitor         run the maintenance now
//
// The old routes keep working on top of the same store: POST /api/saves (site), POST
// /api/upload/backup (app), GET /api/saves/:id/download and DELETE /api/saves/:id.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/internal/backupstore"
	"go-backend/internal/uploads"
	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// MountBackups creates the tables, registers the routes and starts the Drive worker/janitor.
func MountBackups(app fiber.Router, admin fiber.Router) {
	if err := backupstore.Migrate(); err != nil {
		log.Printf("[backups] migrate: %v", err)
	}
	RegisterBackupRoutes(app, admin)
	go backupstore.Default().Run(context.Background())
}

func RegisterBackupRoutes(app fiber.Router, admin fiber.Router) {
	g := app.Group("/api/backups", AuthMiddleware())
	g.Get("/usage", BackupUsage)
	g.Get("/", GetSaves)
	g.Post("/uploads", StartBackupUpload)
	g.Get("/uploads/:id", BackupUploadStatus)
	g.Put("/uploads/:id", BackupUploadChunk)
	g.Post("/uploads/:id/complete", CompleteBackupUpload)
	g.Delete("/uploads/:id", CancelBackupUpload)
	g.Get("/:id/link", BackupDownloadLink)
	// Signed short-lived link: the browser downloads big files natively (no blob in memory).
	app.Get("/api/backup-file/:token", BackupDownloadSigned)
	if admin != nil {
		admin.Get("/backups/stats", AdminBackupStats)
		admin.Post("/backups/janitor", AdminBackupJanitor)
	}
}

func backupUser(c *fiber.Ctx) (*models.User, error) {
	id, err := getUserID(c)
	if err != nil {
		return nil, c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"message": "Unauthenticated"})
	}
	var u models.User
	if database.DB.First(&u, id).Error != nil {
		return nil, c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "User not found"})
	}
	if u.Disabled {
		return nil, c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": "Conta suspensa"})
	}
	return &u, nil
}

// backupError maps store errors to HTTP answers the app and the site understand.
func backupError(c *fiber.Ctx, err error) error {
	var q *backupstore.ErrQuota
	switch {
	case errors.As(err, &q):
		return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{
			"message": q.Error(), "code": "QUOTA_EXCEEDED", "current_usage": q.Used, "reserved": q.Reserved,
			"limit": q.Limit, "need": q.Need, "over_quota": q.OverQuota,
		})
	case errors.Is(err, backupstore.ErrNoPlan):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"message": err.Error(), "code": "PLAN_REQUIRED"})
	case errors.Is(err, backupstore.ErrServerFull):
		return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"message": err.Error(), "code": "SERVER_FULL"})
	case errors.Is(err, backupstore.ErrServerBusy), errors.Is(err, backupstore.ErrNoBackend):
		c.Set("Retry-After", "300")
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"message": err.Error(), "code": "STORAGE_UNAVAILABLE"})
	case errors.Is(err, backupstore.ErrNotFound), errors.Is(err, uploads.ErrNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Backup não encontrado"})
	case errors.Is(err, uploads.ErrTooBig):
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"message": "O envio passou do tamanho reservado"})
	case errors.Is(err, uploads.ErrIncomplete):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": err.Error()})
	case errors.Is(err, backupstore.ErrInvalidSize):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": err.Error()})
	}
	log.Printf("[backups] erro: %v", err)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Não foi possível concluir o backup agora"})
}

func BackupUsage(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	return c.JSON(backupstore.Default().UsageOf(u))
}

// receiveMultipartBackup is the single-request upload (small saves) used by the old routes.
// The plan and quota are checked against the declared part size before it is written to disk.
func receiveMultipartBackup(c *fiber.Ctx, defaultPlatform string) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	fh, ferr := c.FormFile("file")
	if ferr != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "No file uploaded"})
	}
	svc := backupstore.Default()
	if err := svc.Precheck(c.UserContext(), u, fh.Size); err != nil {
		return backupError(c, err)
	}
	ts, _ := strconv.ParseInt(c.FormValue("timestamp"), 10, 64)
	platform := c.FormValue("platform")
	if platform == "" {
		platform = defaultPlatform
	}
	meta := backupstore.Meta{
		GameName: c.FormValue("game_name"), Platform: platform, Kind: c.FormValue("kind"),
		FileName: fh.Filename, Hash: c.FormValue("hash"), Timestamp: ts,
	}
	tmp := svc.StagingPath()
	if err := c.SaveFile(fh, tmp); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Could not save file"})
	}
	save, err := svc.IngestFile(u, meta, tmp)
	if err != nil {
		return backupError(c, err)
	}
	return c.JSON(save)
}

func StartBackupUpload(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	var req struct {
		backupstore.Meta
		Size int64 `json:"size"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "JSON inválido"})
	}
	sess, err := backupstore.Default().StartSession(c.UserContext(), u, req.Meta, req.Size)
	if err != nil {
		return backupError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(backupstore.SessionState{ID: sess.ID, Size: sess.Size, ChunkSize: backupstore.ClientChunk})
}

func BackupUploadStatus(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	st, err := backupstore.Default().SessionStatus(u.ID, c.Params("id"))
	if err != nil {
		return backupError(c, err)
	}
	return c.JSON(st)
}

func BackupUploadChunk(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	offset, perr := strconv.ParseInt(c.Get("Upload-Offset"), 10, 64)
	if perr != nil || offset < 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"message": "Upload-Offset ausente"})
	}
	st, err := backupstore.Default().AppendChunk(u, c.Params("id"), offset, c.Body())
	if errors.Is(err, uploads.ErrOffset) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"message": err.Error(), "received": st.Received})
	}
	if err != nil {
		return backupError(c, err)
	}
	return c.JSON(st)
}

func CompleteBackupUpload(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	save, err := backupstore.Default().CompleteSession(c.UserContext(), u, c.Params("id"))
	if err != nil {
		return backupError(c, err)
	}
	return c.JSON(save)
}

func CancelBackupUpload(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	backupstore.Default().CancelSession(u.ID, c.Params("id"))
	return c.SendStatus(fiber.StatusNoContent)
}

// serveBackup streams one backup (local file, staging copy or Google Drive) with Range support.
func serveBackup(c *fiber.Ctx, save *models.GameSave) error {
	src, err := backupstore.Default().Open(c.UserContext(), save, c.Get("Range"))
	if err != nil {
		return backupError(c, err)
	}
	name := save.FileName
	if name == "" {
		name = fmt.Sprintf("%s-%d.zip", strings.Map(safeRune, save.GameName), save.Timestamp)
	}
	c.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, strings.Map(safeRune, name), url.PathEscape(name)))
	c.Set("Content-Type", "application/octet-stream")
	c.Set("Accept-Ranges", "bytes")
	if src.LocalPath != "" {
		return serveLocalRange(c, src.LocalPath)
	}
	resp := src.Drive
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		c.Set("Content-Length", cl)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		c.Set("Content-Range", cr)
	}
	c.Status(resp.StatusCode)
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer resp.Body.Close()
		_, _ = io.Copy(w, resp.Body)
		_ = w.Flush()
	})
	return nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// serveLocalRange streams a local file with single-range support (no fasthttp file cache:
// staging files are removed as soon as the Drive upload finishes).
func serveLocalRange(c *fiber.Ctx, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"message": "Backup não encontrado"})
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	size := st.Size()
	start, end := int64(0), size-1
	if rg := c.Get("Range"); strings.HasPrefix(rg, "bytes=") && size > 0 && !strings.Contains(rg, ",") {
		a, b, _ := strings.Cut(strings.TrimPrefix(rg, "bytes="), "-")
		s0, e1 := strconv.ParseInt(strings.TrimSpace(a), 10, 64)
		e0, e2 := strconv.ParseInt(strings.TrimSpace(b), 10, 64)
		switch {
		case e1 == nil && e2 == nil && s0 <= e0:
			start, end = s0, min(e0, size-1)
		case e1 == nil && strings.TrimSpace(b) == "":
			start = s0
		case e1 != nil && e2 == nil: // suffix: last N bytes
			start = max(0, size-e0)
		}
		if start >= size || start > end {
			f.Close()
			c.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			return c.SendStatus(fiber.StatusRequestedRangeNotSatisfiable)
		}
		c.Status(fiber.StatusPartialContent)
		c.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		f.Close()
		return err
	}
	n := end - start + 1
	c.Context().SetBodyStream(readCloser{io.LimitReader(f, n), f}, int(n))
	return nil
}

func safeRune(r rune) rune {
	if r < 0x20 || r == '"' || r == '\\' || r == '/' || r > 0x7e {
		return '_'
	}
	return r
}

const downloadLinkTTL = 10 * time.Minute

func BackupDownloadLink(c *fiber.Ctx) error {
	u, err := backupUser(c)
	if u == nil {
		return err
	}
	save, err := backupstore.Default().Get(u.ID, c.Params("id"))
	if err != nil {
		return backupError(c, err)
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": float64(u.ID), "sid": float64(save.ID), "typ": "backup-dl",
		"exp": time.Now().Add(downloadLinkTTL).Unix(),
	}).SignedString([]byte(os.Getenv("JWT_SECRET")))
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"url": "/api/backup-file/" + tok, "expires_in": int(downloadLinkTTL.Seconds())})
}

func BackupDownloadSigned(c *fiber.Ctx) error {
	tok, err := jwt.Parse(c.Params("token"), func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("método inválido")
		}
		return []byte(os.Getenv("JWT_SECRET")), nil
	})
	if err != nil || !tok.Valid {
		return c.Status(fiber.StatusGone).JSON(fiber.Map{"message": "Link expirado. Gere outro na sua conta."})
	}
	claims, _ := tok.Claims.(jwt.MapClaims)
	sub, ok1 := claims["sub"].(float64)
	sid, ok2 := claims["sid"].(float64)
	if !ok1 || !ok2 || claims["typ"] != "backup-dl" {
		return c.Status(fiber.StatusGone).JSON(fiber.Map{"message": "Link inválido"})
	}
	save, err := backupstore.Default().Get(uint(sub), strconv.FormatUint(uint64(sid), 10))
	if err != nil {
		return backupError(c, err)
	}
	c.Set("Cache-Control", "private, no-store")
	return serveBackup(c, save)
}

func AdminBackupStats(c *fiber.Ctx) error {
	return c.JSON(backupstore.Default().Stats(c.UserContext()))
}

func AdminBackupJanitor(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return c.JSON(backupstore.Default().Janitor(ctx))
}
