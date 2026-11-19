package catalog

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Build-time bots (Node, scripts/catalog): discover.mjs, build-ports.mjs, build-art.mjs, build-meta.mjs.
// Each one merges a section into a machine-readable report (scripts/catalog/report.mjs):
//
//   - go-backend/internal/catalog/build-report.json, embedded here, so every deployed binary carries
//     the report of the build that produced its catalog.json;
//   - $CATALOG_BUILD_REPORT too, when set (the runner below sets it to Config.BuildReportPath, so a run
//     started from the admin shows up without rebuilding the server).
//
// The server serves whichever of the two is newer.

//go:embed build-report.json
var embeddedBuildReport []byte

// buildJobs are the scripts the admin may start (only when CATALOG_BUILD_ROOT points to the repository
// and node is installed: the production image has no node, so there they are build-time only).
var buildJobs = []struct {
	ID, Label string
	Scripts   []string
}{
	{"discover", "Descobrir ports (listas, Recompendium, busca do GitHub)", []string{"scripts/catalog/discover.mjs"}},
	{"ports", "Montar o catálogo de ports", []string{"scripts/catalog/build-ports.mjs"}},
	{"art", "Capas (build-art)", []string{"scripts/catalog/build-art.mjs"}},
	{"media", "Capas + metadados (media:build)", []string{"scripts/catalog/build-art.mjs", "scripts/catalog/build-meta.mjs", "scripts/catalog/build-art.mjs"}},
}

const buildLogLines = 300

type buildRunner struct {
	mu         sync.Mutex
	root       string
	node       string
	reportPath string
	disabled   string // why the runner is off ("" = available)

	running    bool
	job        string
	startedAt  time.Time
	finishedAt time.Time
	exitCode   *int
	err        string
	log        []string

	cacheMod  time.Time
	cacheSize int64
	cacheData []byte
}

func (b *buildRunner) init(cfg Config) {
	b.reportPath = cfg.BuildReportPath
	if b.reportPath == "" && cfg.DataDir != "" {
		b.reportPath = filepath.Join(cfg.DataDir, "build-report.json")
	}
	b.root = cfg.BuildRoot
	switch {
	case b.root == "":
		b.disabled = "CATALOG_BUILD_ROOT não está definido: os robôs de build rodam fora do servidor (npm run …)."
		return
	case !isFile(filepath.Join(b.root, "scripts", "catalog", "build-art.mjs")):
		b.disabled = "CATALOG_BUILD_ROOT não aponta para o repositório (scripts/catalog não encontrado)."
		return
	}
	b.node = cfg.NodeBin
	if b.node == "" {
		b.node = "node"
	}
	if p, err := exec.LookPath(b.node); err == nil {
		b.node = p
	} else {
		b.disabled = "Node.js não está instalado neste servidor."
	}
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func reportTime(b []byte) time.Time {
	var h struct {
		GeneratedAt time.Time `json:"generatedAt"`
	}
	json.Unmarshal(b, &h)
	return h.GeneratedAt
}

// report returns the newest build report (runtime file or embedded) and where it came from.
func (b *buildRunner) report() ([]byte, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var runtime []byte
	if b.reportPath != "" {
		if st, err := os.Stat(b.reportPath); err == nil {
			if st.ModTime().Equal(b.cacheMod) && st.Size() == b.cacheSize {
				runtime = b.cacheData
			} else if data, err := os.ReadFile(b.reportPath); err == nil && json.Valid(data) {
				b.cacheMod, b.cacheSize, b.cacheData = st.ModTime(), st.Size(), data
				runtime = data
			}
		}
	}
	embedded := embeddedBuildReport
	if !json.Valid(embedded) {
		embedded = nil
	}
	switch {
	case runtime != nil && (embedded == nil || !reportTime(runtime).Before(reportTime(embedded))):
		return runtime, "runtime"
	case embedded != nil:
		return embedded, "embedded"
	}
	return nil, ""
}

// ErrBuildDisabled = the build scripts cannot run on this server.
var ErrBuildDisabled = errors.New("os robôs de build não rodam neste servidor")

// start runs a build job in the background. args: offline / budget (seconds, 0 = no limit).
func (b *buildRunner) start(job string, offline bool, budget int) error {
	var scripts []string
	for _, j := range buildJobs {
		if j.ID == job {
			scripts = j.Scripts
		}
	}
	if scripts == nil {
		return errors.New("job desconhecido: " + job)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.disabled != "" {
		return ErrBuildDisabled
	}
	if b.running {
		return ErrBusy
	}
	b.running, b.job, b.startedAt, b.finishedAt, b.exitCode, b.err, b.log = true, job, time.Now(), time.Time{}, nil, "", nil
	go b.run(scripts, offline, budget)
	return nil
}

func (b *buildRunner) appendLog(line string) {
	b.mu.Lock()
	b.log = append(b.log, shorten(line, 400))
	if len(b.log) > buildLogLines {
		b.log = append([]string(nil), b.log[len(b.log)-buildLogLines:]...)
	}
	b.mu.Unlock()
}

func (b *buildRunner) run(scripts []string, offline bool, budget int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	code, errMsg := 0, ""
	for _, script := range scripts {
		args := []string{"--experimental-strip-types", script}
		if offline {
			args = append(args, "--offline")
		}
		if budget > 0 {
			args = append(args, "--budget", strconv.Itoa(budget))
			if strings.HasSuffix(script, "build-ports.mjs") {
				args = append(args, "--partial") // out of time: write what is ready instead of exiting 3
			}
		}
		b.appendLog("$ node " + strings.Join(args, " "))
		cmd := exec.CommandContext(ctx, b.node, args...)
		cmd.Dir = b.root
		cmd.Env = append(os.Environ(), "CATALOG_BUILD_REPORT="+b.reportPath)
		pr, pw := io.Pipe()
		cmd.Stdout, cmd.Stderr = pw, pw
		done := make(chan struct{})
		go func() {
			defer close(done)
			sc := bufio.NewScanner(pr)
			sc.Buffer(make([]byte, 64<<10), 1<<20)
			for sc.Scan() {
				if line := strings.TrimRight(sc.Text(), "\r"); line != "" {
					b.appendLog(line)
				}
			}
			io.Copy(io.Discard, pr)
		}()
		err := cmd.Run()
		pw.Close()
		<-done
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
			errMsg = err.Error()
			break
		}
	}
	b.mu.Lock()
	b.running, b.finishedAt, b.exitCode, b.err = false, time.Now(), &code, errMsg
	b.mu.Unlock()
}

type buildJobView struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command"`
}

type buildRunnerView struct {
	Enabled    bool       `json:"enabled"`
	Reason     string     `json:"reason,omitempty"`
	Running    bool       `json:"running"`
	Job        string     `json:"job,omitempty"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	ExitCode   *int       `json:"exitCode,omitempty"`
	Error      string     `json:"error,omitempty"`
	Log        []string   `json:"log,omitempty"`
}

func tp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (b *buildRunner) view(withLog bool) buildRunnerView {
	b.mu.Lock()
	defer b.mu.Unlock()
	v := buildRunnerView{Enabled: b.disabled == "", Reason: b.disabled, Running: b.running, Job: b.job,
		StartedAt: tp(b.startedAt), FinishedAt: tp(b.finishedAt), ExitCode: b.exitCode, Error: b.err}
	if withLog {
		v.Log = append([]string(nil), b.log...)
	} else if n := len(b.log); n > 0 {
		v.Log = append([]string(nil), b.log[max(0, n-40):]...)
	}
	return v
}

func jobViews() []buildJobView {
	cmd := map[string]string{
		"discover": "node scripts/catalog/discover.mjs",
		"ports":    "npm run catalog:build",
		"art":      "npm run art:build",
		"media":    "npm run media:build",
	}
	out := make([]buildJobView, 0, len(buildJobs))
	for _, j := range buildJobs {
		out = append(out, buildJobView{ID: j.ID, Label: j.Label, Command: cmd[j.ID]})
	}
	return out
}

// summarizeReport keeps the scalar fields of each section and turns lists into counts
// (the full lists are served by /api/admin/scrape/build/report).
func summarizeReport(raw []byte) map[string]any {
	if raw == nil {
		return nil
	}
	var rep map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&rep) != nil {
		return nil
	}
	sections, _ := rep["sections"].(map[string]any)
	for name, v := range sections {
		sec, ok := v.(map[string]any)
		if !ok {
			continue
		}
		out := map[string]any{}
		for k, f := range sec {
			if list, ok := f.([]any); ok {
				out[k+"Count"] = len(list)
				if k == "errors" {
					out[k] = list[:min(len(list), 10)]
				}
				continue
			}
			out[k] = f
		}
		sections[name] = out
	}
	return rep
}

// BuildArtEntry is what the build-time art bot (build-art.mjs) reported for one game.
type BuildArtEntry struct {
	Title    string           `json:"title"`
	Status   string           `json:"status"` // missing | fallback
	Best     json.RawMessage  `json:"best,omitempty"`
	Attempts []map[string]any `json:"attempts,omitempty"`
}

// buildArtFor finds the build-time art report of a game (by projectName, then name).
func buildArtFor(raw []byte, titles ...string) *BuildArtEntry {
	if raw == nil {
		return nil
	}
	var rep struct {
		Sections struct {
			Art struct {
				Missing  []BuildArtEntry `json:"missing"`
				Fallback []BuildArtEntry `json:"fallback"`
			} `json:"art"`
		} `json:"sections"`
	}
	if json.Unmarshal(raw, &rep) != nil {
		return nil
	}
	for _, t := range titles {
		if t == "" {
			continue
		}
		for _, group := range []struct {
			status string
			list   []BuildArtEntry
		}{{"missing", rep.Sections.Art.Missing}, {"fallback", rep.Sections.Art.Fallback}} {
			for i := range group.list {
				if group.list[i].Title == t {
					e := group.list[i]
					if e.Status == "" {
						e.Status = group.status
					}
					return &e
				}
			}
		}
	}
	return nil
}
