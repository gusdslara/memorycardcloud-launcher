package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Attempt results (same vocabulary as the build-time report written by scripts/catalog/report.mjs).
const (
	ResultOK          = "ok"           // image stored
	ResultNotModified = "not_modified" // cached image revalidated (304)
	ResultHTTP        = "http"         // upstream answered a non-2xx status (Status)
	ResultRateLimited = "rate_limited" // 429, or 403 with an exhausted rate limit
	ResultNetwork     = "network"      // timeout, DNS, connection reset...
	ResultNotImage    = "not_image"    // 200 but the content is not an image
	ResultTooLarge    = "too_large"    // over MaxImageBytes
	ResultNoMatch     = "no_match"     // lookup found nothing (no article, no search hit)
	ResultRejected    = "rejected"     // lookup found something, but it is not this game (franchise, disambiguation...)
	ResultError       = "error"        // anything else (bad JSON, bad URL)
)

// maxAttempts bounds the per-image attempt log kept in state.json.
const maxAttempts = 24

// ImageAttempt is one source tried while looking for an item's image.
type ImageAttempt struct {
	At     time.Time `json:"at"`
	Source string    `json:"source"`
	URL    string    `json:"url,omitempty"`
	Result string    `json:"result"`
	Status int       `json:"status,omitempty"`
	Detail string    `json:"detail,omitempty"`
	Ms     int64     `json:"ms,omitempty"`
}

// IsFailure tells whether the attempt hit an error (not just "nothing found").
func (a ImageAttempt) IsFailure() bool {
	switch a.Result {
	case ResultHTTP, ResultRateLimited, ResultNetwork, ResultNotImage, ResultTooLarge, ResultError:
		return true
	}
	return false
}

// httpStatusError is a non-2xx answer from an upstream (keeps the status for the attempt log).
type httpStatusError struct {
	URL        string
	StatusCode int
	Status     string
	RateLimit  bool
}

func (e *httpStatusError) Error() string { return fmt.Sprintf("download %s: %s", e.URL, e.Status) }

func isRateLimited(resp *http.Response) bool {
	if resp.StatusCode == http.StatusTooManyRequests {
		return true
	}
	return resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0"
}

// lookupErr explains why a lazy lookup (Wikipedia, SteamGridDB, website) gave no URL.
type lookupErr struct {
	Result string
	Status int
	Detail string
}

func (e *lookupErr) Error() string { return e.Detail }

func miss(result, format string, a ...any) *lookupErr {
	return &lookupErr{Result: result, Detail: fmt.Sprintf(format, a...)}
}

// classify turns an error of downloadBlob/getJSON into an attempt result.
func classify(err error) (result string, status int, detail string) {
	var he *httpStatusError
	var le *lookupErr
	switch {
	case err == nil:
		return ResultOK, 0, ""
	case errors.As(err, &le):
		return le.Result, le.Status, le.Detail
	case errors.As(err, &he):
		if he.RateLimit {
			return ResultRateLimited, he.StatusCode, "limite de requisições (" + he.Status + ")"
		}
		return ResultHTTP, he.StatusCode, he.Status
	case errors.Is(err, errTooLarge):
		return ResultTooLarge, 0, "imagem maior que o limite"
	case errors.Is(err, context.Canceled):
		return ResultNetwork, 0, "cancelado"
	default:
		return ResultNetwork, 0, shorten(err.Error(), 200)
	}
}

func shorten(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// getJSON GETs u and decodes the body into out, explaining failures for the attempt log.
func (s *Service) getJSON(ctx context.Context, u string, hdr http.Header, limit int64, out any) *lookupErr {
	req, err := s.newRequest(ctx, http.MethodGet, u)
	if err != nil {
		return miss(ResultError, "URL inválida")
	}
	for k, vs := range hdr {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		r, _, d := classify(err)
		return miss(r, "%s", d)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		if isRateLimited(resp) {
			return &lookupErr{Result: ResultRateLimited, Status: resp.StatusCode, Detail: "limite de requisições (" + resp.Status + ")"}
		}
		if resp.StatusCode == http.StatusNotFound {
			return &lookupErr{Result: ResultNoMatch, Status: resp.StatusCode, Detail: "não encontrado (404)"}
		}
		return &lookupErr{Result: ResultHTTP, Status: resp.StatusCode, Detail: resp.Status}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, limit)).Decode(out); err != nil {
		return miss(ResultError, "resposta inválida")
	}
	return nil
}

// attemptLog collects the attempts of one image check.
type attemptLog []ImageAttempt

func (l *attemptLog) add(a ImageAttempt) {
	if a.At.IsZero() {
		a.At = time.Now()
	}
	a.Detail = shorten(strings.TrimSpace(a.Detail), 300)
	*l = append(*l, a)
}

func (l attemptLog) bounded() []ImageAttempt {
	if len(l) > maxAttempts {
		// keep the first ones (best sources) and the last one (what finally worked or failed)
		out := append([]ImageAttempt{}, l[:maxAttempts-1]...)
		return append(out, l[len(l)-1])
	}
	return l
}
