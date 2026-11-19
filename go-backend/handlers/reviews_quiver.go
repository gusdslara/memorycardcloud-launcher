package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"go-backend/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Importer of compatibility reports from Quiver Launcher's public, read-only catalog API
// (https://api.quiverlauncher.com/api/v1, spec at /openapi.json: "Public read-only catalog").
// Quiver's players report from every system (Windows, Linux, macOS, Android, iOS), so these are
// what fills the Android/iOS tabs of a port's reviews.
//
// Matching: Quiver's /release-status lists every published app with its repository; a port gets the
// reports of every Quiver app whose repository it installs from (its own or a platformRepos build).
//
// Polite like the RecompLauncher importer: pages of 100, ≥1.5 s between requests, reports are fetched
// only for apps whose reviewCount changed since the last run, the run stops at 403/429/5xx.

const (
	defaultQuiverAPI   = "https://api.quiverlauncher.com/api/v1"
	quiverReviewAuthor = "Jogador do Quiver Launcher"
	quiverPageLimit    = 100
	// quiverMaxPages caps one listing (100 pages × 100 apps) in case the cursor never ends.
	quiverMaxPages = 100
)

// QuiverAPI is the base URL of the API (env QUIVER_API overrides it; empty disables the importer).
var QuiverAPI = defaultQuiverAPI

type quiverPage[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor"`
	IsDone     bool   `json:"isDone"`
}

type quiverReleaseStatus struct {
	Slug       string `json:"slug"`
	Provider   string `json:"provider"`
	Repository string `json:"repository"`
}

type quiverApp struct {
	Slug        string `json:"slug"`
	ReviewCount int    `json:"reviewCount"`
}

type quiverSpecs struct {
	OSVersion string  `json:"osVersion"`
	CPU       string  `json:"cpu"`
	GPU       string  `json:"gpu"`
	RAMGb     float64 `json:"ramGb"`
}

type quiverFeedback struct {
	ID              string           `json:"id"`
	Version         string           `json:"version"`
	Result          string           `json:"result"`
	Body            string           `json:"body"`
	Platform        string           `json:"platform"`
	CreatedAt       int64            `json:"createdAt"`
	ModeratorHidden bool             `json:"moderatorHidden"`
	UnderReview     bool             `json:"underReview"`
	Fixed           *json.RawMessage `json:"fixed"`
	Specs           *quiverSpecs     `json:"specs"`
	SpecsPublic     *bool            `json:"specsPublic"`
}

func quiverGet(ctx context.Context, path string, q url.Values, out any) error {
	u := strings.TrimRight(QuiverAPI, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
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
		return &errReviewImportBlocked{Status: resp.StatusCode, RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")), Source: "Quiver"}
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Quiver %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out)
}

// quiverAll reads every page of a listing.
func quiverAll[T any](ctx context.Context, path string, extra url.Values) ([]T, error) {
	var all []T
	cursor := ""
	for page := 0; page < quiverMaxPages; page++ {
		q := url.Values{"limit": {fmt.Sprint(quiverPageLimit)}}
		for k, v := range extra {
			q[k] = v
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		if page > 0 {
			if err := sleepCtx(ctx, ReviewImportDelay); err != nil {
				return all, err
			}
		}
		var p quiverPage[T]
		if err := quiverGet(ctx, path, q, &p); err != nil {
			return all, err
		}
		all = append(all, p.Items...)
		if p.IsDone || p.NextCursor == "" || len(p.Items) == 0 {
			break
		}
		cursor = p.NextCursor
	}
	return all, nil
}

// ImportQuiverReviews performs one import run.
func ImportQuiverReviews(ctx context.Context, db *gorm.DB) (ReviewImportResult, error) {
	var res ReviewImportResult
	if strings.TrimSpace(QuiverAPI) == "" {
		return res, nil
	}
	cat, err := reviewCatalog()
	if err != nil {
		return res, err
	}
	byRepo := cat.PortsByRepo()
	if len(byRepo) == 0 {
		return res, nil
	}

	// slug → our ports (through the app's repository)
	statuses, err := quiverAll[quiverReleaseStatus](ctx, "/release-status", nil)
	if err != nil {
		return res, err
	}
	portsBySlug := map[string][]string{}
	for _, s := range statuses {
		if s.Slug == "" || (s.Provider != "" && s.Provider != "github") {
			continue // our catalog installs from GitHub
		}
		if ids := byRepo[strings.ToLower(strings.Trim(s.Repository, "/"))]; len(ids) > 0 {
			portsBySlug[s.Slug] = ids
		}
	}
	if len(portsBySlug) == 0 {
		return res, nil
	}

	// how many reports each app has now (skips apps that didn't change)
	if err := sleepCtx(ctx, ReviewImportDelay); err != nil {
		return res, err
	}
	apps, err := quiverAll[quiverApp](ctx, "/apps", nil)
	if err != nil {
		return res, err
	}
	counts := map[string]int{}
	for _, a := range apps {
		counts[a.Slug] = a.ReviewCount
	}

	slugs := make([]string, 0, len(portsBySlug))
	for slug := range portsBySlug {
		slugs = append(slugs, slug)
	}
	sort.Strings(slugs)

	defer func() {
		if res.Inserted > 0 {
			invalidateReviewSummaries()
		}
	}()

	for _, slug := range slugs {
		total := counts[slug]
		var state models.ReviewImportState
		found := db.Where("source = ? AND external_id = ?", models.ReviewSourceQuiver, slug).Limit(1).Find(&state).RowsAffected > 0
		if (found && state.Total == total) || (!found && total == 0) {
			res.Skipped++
			continue
		}
		if err := sleepCtx(ctx, ReviewImportDelay); err != nil {
			return res, err
		}
		items, err := quiverAll[quiverFeedback](ctx, "/apps/"+url.PathEscape(slug)+"/reviews", nil)
		var blocked *errReviewImportBlocked
		if errors.As(err, &blocked) || errors.Is(err, context.Canceled) {
			return res, err
		}
		res.Fetched++
		if err != nil {
			log.Printf("[reviews] Quiver %s: %v", slug, err)
			continue
		}
		// um INSERT por lote (não um por relato): a primeira carga traz milhares de relatos
		rows := []models.PortReview{}
		for _, it := range items {
			rows = append(rows, quiverReviewRows(it, portsBySlug[slug])...)
		}
		if len(rows) > 0 {
			r := db.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(&rows, 200)
			if r.Error != nil {
				return res, r.Error
			}
			res.Inserted += int(r.RowsAffected)
		}
		state.Source, state.ExternalID, state.Total, state.CheckedAt = models.ReviewSourceQuiver, slug, total, time.Now()
		if err := db.Save(&state).Error; err != nil {
			return res, err
		}
	}
	return res, nil
}

// quiverReviewRows converts one Quiver report into a review per mapped port. Reports hidden by
// moderators, still under review, or marked fixed by the developer (Quiver stops counting them) are skipped.
func quiverReviewRows(it quiverFeedback, portIDs []string) []models.PortReview {
	verdict := strings.ToLower(strings.TrimSpace(it.Result))
	if it.ID == "" || it.ModeratorHidden || it.UnderReview || it.Fixed != nil ||
		(verdict != "runs" && verdict != "issues" && verdict != "broken") {
		return nil
	}
	created := time.UnixMilli(it.CreatedAt).UTC()
	if it.CreatedAt <= 0 {
		created = time.Now().UTC()
	}
	platform := normalizeRLPlatform(it.Platform)
	hardware := ""
	if it.Specs != nil && (it.SpecsPublic == nil || *it.SpecsPublic) {
		parts := []string{}
		for _, p := range []string{it.Specs.OSVersion, it.Specs.CPU, it.Specs.GPU} {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		if it.Specs.RAMGb > 0 {
			parts = append(parts, fmt.Sprintf("%g GB", it.Specs.RAMGb))
		}
		hardware = strings.Join(parts, " · ")
	}
	key := models.ReviewSourceQuiver + ":" + it.ID
	rows := make([]models.PortReview, 0, len(portIDs))
	for _, pid := range portIDs {
		k := key
		rows = append(rows, models.PortReview{
			PortID:      pid,
			Source:      models.ReviewSourceQuiver,
			ExternalKey: &k,
			Author:      quiverReviewAuthor,
			Hardware:    truncateRunes(hardware, reviewMaxHardware),
			Platform:    platform,
			Version:     truncateRunes(strings.TrimSpace(it.Version), reviewMaxVersion),
			Verdict:     verdict,
			Note:        truncateRunes(strings.TrimSpace(it.Body), reviewMaxNote),
			CreatedAt:   created,
		})
	}
	return rows
}

func quiverAPIFromEnv() {
	if v, ok := os.LookupEnv("QUIVER_API"); ok {
		QuiverAPI = strings.TrimSpace(v)
	}
}
