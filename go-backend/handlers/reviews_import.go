package handlers

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"go-backend/database"
	"go-backend/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Importer of player reports from RecompLauncher's public, anonymous API
// (docs: github.com/elripalda/RecompLauncher/blob/HEAD/docs/LAUNCHER-API.md).
//
// Polite by design: one `a=counts` call per run, `a=feedback` only for apps that
// a catalog port references (externalIds.recomplauncher) AND whose report count
// changed since the last import, ≥1.5 s between requests, an honest User-Agent,
// and the run stops at the first 403/429/5xx (Retry-After respected).

const (
	reviewImportUserAgent    = "MemoryCardCloud-Reviews/1.0 (+https://memorycard.cloud)"
	reviewImportAuthor       = "Jogador do RecompLauncher"
	defaultRecompLauncherAPI = "https://recomplauncher.com/api/pc.php"
)

var (
	// RecompLauncherAPI is the base URL of the API (env RECOMPLAUNCHER_API overrides it).
	RecompLauncherAPI = defaultRecompLauncherAPI
	// ReviewImportDelay is the pause between two requests of a run.
	ReviewImportDelay = 1500 * time.Millisecond
	// ReviewImportFirstRun / ReviewImportInterval schedule the background loop.
	ReviewImportFirstRun   = time.Minute
	ReviewImportInterval   = 6 * time.Hour
	reviewImportHTTPClient = &http.Client{Timeout: 15 * time.Second}
)

// errReviewImportBlocked stops a run (403/429/5xx); RetryAfter is 0 when not sent.
type errReviewImportBlocked struct {
	Status     int
	RetryAfter time.Duration
	Source     string // "" = RecompLauncher
}

func (e *errReviewImportBlocked) Error() string {
	src := e.Source
	if src == "" {
		src = "RecompLauncher"
	}
	return fmt.Sprintf("%s respondeu HTTP %d", src, e.Status)
}

type rlCounts struct {
	Runs   int `json:"runs"`
	Issues int `json:"issues"`
	Broken int `json:"broken"`
}

func (c rlCounts) total() int { return c.Runs + c.Issues + c.Broken }

type rlCountsResponse struct {
	OK     bool                `json:"ok"`
	Counts map[string]rlCounts `json:"counts"`
}

type rlFeedbackItem struct {
	Verdict string `json:"verdict"`
	Sys     string `json:"sys"`
	Proton  bool   `json:"proton"`
	Version string `json:"version"`
	Note    string `json:"note"`
	Specs   string `json:"specs"`
	When    string `json:"when"`
}

type rlFeedbackResponse struct {
	OK    bool             `json:"ok"`
	Items []rlFeedbackItem `json:"items"`
}

// ReviewImportResult summarizes one run.
type ReviewImportResult struct {
	Fetched  int // a=feedback calls
	Inserted int // new review rows
	Skipped  int // apps unchanged since the last run
}

// StartReviewImporter runs the importer in the background: first run ~1 minute
// after start, then every 6 hours. Disabled with REVIEWS_IMPORT=false.
func StartReviewImporter(ctx context.Context) {
	if strings.EqualFold(os.Getenv("REVIEWS_IMPORT"), "false") {
		log.Println("[reviews] importação do RecompLauncher desativada (REVIEWS_IMPORT=false)")
		return
	}
	if v := strings.TrimSpace(os.Getenv("RECOMPLAUNCHER_API")); v != "" {
		RecompLauncherAPI = v
	}
	quiverAPIFromEnv()
	go func() {
		wait := ReviewImportFirstRun
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = ReviewImportInterval
			res, err := ImportRecompLauncherReviews(ctx, database.DB)
			var blocked *errReviewImportBlocked
			switch {
			case errors.As(err, &blocked):
				log.Printf("[reviews] importação interrompida: %v (Retry-After %s)", err, blocked.RetryAfter)
				if blocked.RetryAfter > wait {
					wait = blocked.RetryAfter
				}
			case err != nil:
				log.Printf("[reviews] importação falhou: %v", err)
			default:
				log.Printf("[reviews] RecompLauncher: %d apps consultados, %d sem mudança, %d avaliações novas",
					res.Fetched, res.Skipped, res.Inserted)
			}
			// Quiver Launcher (todas as plataformas, inclusive Android/iOS): fonte independente
			qres, qerr := ImportQuiverReviews(ctx, database.DB)
			switch {
			case errors.As(qerr, &blocked):
				log.Printf("[reviews] Quiver interrompido: %v (Retry-After %s)", qerr, blocked.RetryAfter)
				if blocked.RetryAfter > wait {
					wait = blocked.RetryAfter
				}
			case qerr != nil:
				log.Printf("[reviews] Quiver falhou: %v", qerr)
			default:
				log.Printf("[reviews] Quiver: %d apps consultados, %d sem mudança, %d avaliações novas",
					qres.Fetched, qres.Skipped, qres.Inserted)
			}
		}
	}()
}

// ImportRecompLauncherReviews performs one import run.
func ImportRecompLauncherReviews(ctx context.Context, db *gorm.DB) (ReviewImportResult, error) {
	var res ReviewImportResult
	cat, err := reviewCatalog()
	if err != nil {
		return res, err
	}
	ports := cat.PortsByExternalID(models.ReviewSourceRecompLauncher)
	if len(ports) == 0 {
		return res, nil // nothing references RecompLauncher: no request at all
	}

	var counts rlCountsResponse
	if err := rlGet(ctx, url.Values{"a": {"counts"}}, &counts); err != nil {
		return res, err
	}
	if !counts.OK {
		return res, errors.New("RecompLauncher a=counts: ok=false")
	}

	rlIDs := make([]string, 0, len(ports))
	for id := range ports {
		rlIDs = append(rlIDs, id)
	}
	sort.Strings(rlIDs)

	defer func() {
		if res.Inserted > 0 {
			invalidateReviewSummaries()
		}
	}()

	for _, rlID := range rlIDs {
		total := counts.Counts[rlID].total()
		var state models.ReviewImportState
		found := db.Where("source = ? AND external_id = ?", models.ReviewSourceRecompLauncher, rlID).
			Limit(1).Find(&state).RowsAffected > 0
		if (found && state.Total == total) || (!found && total == 0) {
			res.Skipped++
			continue
		}

		if err := sleepCtx(ctx, ReviewImportDelay); err != nil {
			return res, err
		}
		var fb rlFeedbackResponse
		err := rlGet(ctx, url.Values{"a": {"feedback"}, "id": {rlID}}, &fb)
		var blocked *errReviewImportBlocked
		if errors.As(err, &blocked) || errors.Is(err, context.Canceled) {
			return res, err
		}
		res.Fetched++
		if err != nil || !fb.OK {
			log.Printf("[reviews] RecompLauncher a=feedback id=%s: %v (ok=%v)", rlID, err, fb.OK)
			continue
		}

		for _, it := range fb.Items {
			rows := rlReviewRows(rlID, it, ports[rlID])
			if len(rows) == 0 {
				continue
			}
			r := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows)
			if r.Error != nil {
				return res, r.Error
			}
			res.Inserted += int(r.RowsAffected)
		}

		state.Source, state.ExternalID, state.Total, state.CheckedAt = models.ReviewSourceRecompLauncher, rlID, total, time.Now()
		if err := db.Save(&state).Error; err != nil {
			return res, err
		}
	}
	return res, nil
}

// rlReviewRows converts one RecompLauncher report into a review per mapped port.
func rlReviewRows(rlID string, it rlFeedbackItem, portIDs []string) []models.PortReview {
	verdict := strings.ToLower(strings.TrimSpace(it.Verdict))
	if verdict != "runs" && verdict != "issues" && verdict != "broken" {
		return nil
	}
	sum := sha1.Sum([]byte(models.ReviewSourceRecompLauncher + "|" + rlID + "|" + it.When + "|" + it.Specs + "|" + it.Version))
	key := hex.EncodeToString(sum[:])
	created, err := time.Parse(time.RFC3339, strings.TrimSpace(it.When))
	if err != nil {
		created = time.Now()
	}
	platform := normalizeRLPlatform(it.Sys)
	rows := make([]models.PortReview, 0, len(portIDs))
	for _, pid := range portIDs {
		k := key
		rows = append(rows, models.PortReview{
			PortID:      pid,
			Source:      models.ReviewSourceRecompLauncher,
			ExternalKey: &k,
			Author:      reviewImportAuthor,
			Hardware:    truncateRunes(strings.TrimSpace(it.Specs), reviewMaxHardware),
			Platform:    platform,
			Version:     truncateRunes(strings.TrimSpace(it.Version), reviewMaxVersion),
			Verdict:     verdict,
			Note:        truncateRunes(strings.TrimSpace(it.Note), reviewMaxNote),
			CreatedAt:   created.UTC(),
		})
	}
	return rows
}

func normalizeRLPlatform(sys string) string {
	s := strings.ToLower(strings.TrimSpace(sys))
	switch s {
	case "mac", "osx", "darwin", "macos":
		return "macos"
	}
	if reviewPlatforms[s] {
		return s
	}
	return ""
}

func rlGet(ctx context.Context, q url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, RecompLauncherAPI+"?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", reviewImportUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := reviewImportHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return &errReviewImportBlocked{Status: resp.StatusCode, RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
