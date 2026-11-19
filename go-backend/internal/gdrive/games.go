package gdrive

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"go-backend/models"
)

// Library layouts of a folder (RomSource.Layout).
const (
	LayoutAuto    = "auto"    // detect per folder
	LayoutLoose   = "loose"   // games are loose files (cue+bin with the same name still form one game)
	LayoutFolders = "folders" // every sub-folder of a console folder is one game
)

// ScanOptions configures ScanSource.
type ScanOptions struct {
	Console  string          // "" = automatic: each first-level sub-folder is a console
	Layout   string          // auto | loose | folders
	Skip     map[string]bool // folder ids handled by another source (not walked)
	MaxDepth int
}

// DriveEntry is a file or folder shown by the admin's Drive browser.
type DriveEntry struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Folder   bool   `json:"folder"`
	Size     int64  `json:"size"`
	Modified string `json:"modified,omitempty"`
	Console  string `json:"console,omitempty"` // console recognised from the folder name
}

// ListChildren lists folders and files of a folder ("root" = My Drive), folders first.
func (s *DriveService) ListChildren(ctx context.Context, parent string) ([]DriveEntry, error) {
	if parent == "" {
		parent = "root"
	}
	files, err := s.list(ctx, fmt.Sprintf("'%s' in parents and trashed=false", escapeQ(parent)))
	if err != nil {
		return nil, err
	}
	out := make([]DriveEntry, 0, len(files))
	for _, f := range files {
		if f.MimeType != folderMime && strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") {
			continue
		}
		e := DriveEntry{ID: f.ID, Name: f.Name, Folder: f.MimeType == folderMime, Modified: f.ModifiedTime}
		if e.Folder {
			if c, ok := KnownConsole(f.Name); ok {
				e.Console = c
			}
		} else {
			fmt.Sscanf(f.Size, "%d", &e.Size)
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Folder != out[j].Folder {
			return out[i].Folder
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// KnownConsole reports whether a folder name is a console the library recognises.
func KnownConsole(name string) (string, bool) {
	c := ConsoleFromFolder(name)
	return c, c != strings.TrimSpace(name) || isConsoleCode(c)
}

func isConsoleCode(c string) bool {
	for _, k := range Consoles {
		if strings.EqualFold(k, c) {
			return true
		}
	}
	return false
}

// Consoles are the codes produced by ConsoleFromFolder (the admin's console select).
var Consoles = []string{
	"PS1", "PS2", "PS3", "PS4", "PSP", "Vita",
	"NES", "SNES", "N64", "GameCube", "Wii", "Wii U", "Switch",
	"GameBoy", "GBA", "NDS", "3DS",
	"Mega Drive", "Sega CD", "Saturn", "Dreamcast",
	"Xbox", "Xbox 360", "PC", "BIOS",
}

// ScanSource walks a library folder. With opt.Console set, everything below belongs to that
// console; otherwise each first-level sub-folder is a console (like ScanTree). Files are then
// grouped into games (see DetectGames).
func (s *DriveService) ScanSource(ctx context.Context, rootID string, opt ScanOptions) ([]models.RomItem, error) {
	if rootID == "" {
		return nil, errors.New("nenhuma pasta escolhida")
	}
	if opt.MaxDepth <= 0 {
		opt.MaxDepth = 6
	}
	fixed := strings.TrimSpace(opt.Console)
	var items []models.RomItem
	// path: relative to the source; consoleDir: path of the console folder; rel: dir inside it.
	var walk func(id, p, console, consoleDir, rel string, depth int) error
	walk = func(id, p, console, consoleDir, rel string, depth int) error {
		files, err := s.list(ctx, fmt.Sprintf("'%s' in parents and trashed=false", escapeQ(id)))
		if err != nil {
			return err
		}
		for _, f := range files {
			if f.MimeType == folderMime {
				if depth >= opt.MaxDepth || opt.Skip[f.ID] {
					continue
				}
				child := strings.TrimPrefix(p+"/"+f.Name, "/")
				if fixed == "" && depth == 0 {
					if err := walk(f.ID, child, ConsoleFromFolder(f.Name), child, "", depth+1); err != nil {
						return err
					}
					continue
				}
				if err := walk(f.ID, child, console, consoleDir, strings.TrimPrefix(rel+"/"+f.Name, "/"), depth+1); err != nil {
					return err
				}
				continue
			}
			if strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") || ignoredFile(f.Name) {
				continue
			}
			var size int64
			fmt.Sscanf(f.Size, "%d", &size)
			mod, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			if mod.IsZero() {
				mod = time.Now()
			}
			cons := console
			if fixed != "" {
				cons = fixed
				if !strings.EqualFold(fixed, "BIOS") && strings.Contains(strings.ToLower(f.Name), "bios") {
					cons = "BIOS"
				}
			} else if cons == "" || strings.Contains(strings.ToLower(f.Name), "bios") {
				cons = InferConsole(f.Name, p)
			}
			items = append(items, models.RomItem{
				DriveFileID:   f.ID,
				Name:          f.Name,
				Console:       cons,
				Extension:     strings.ToLower(pathExt(f.Name)),
				SizeBytes:     size,
				SizeFormatted: FormatBytes(size),
				MimeType:      f.MimeType,
				FolderPath:    p,
				DownloadURL:   fmt.Sprintf("/api/roms/%s/download", f.ID),
				IsAvailable:   true,
				ModifiedAt:    mod,
				ConsoleDir:    consoleDir,
				RelDir:        rel,
			})
		}
		return nil
	}
	if err := walk(rootID, "", fixed, "", "", 0); err != nil {
		return nil, err
	}
	DetectGames(items, opt.Layout)
	return items, nil
}

func pathExt(name string) string {
	i := strings.LastIndex(name, ".")
	if i <= 0 {
		return ""
	}
	return name[i:]
}

// --- game detection ---

var (
	multiPartExt = regexp.MustCompile(`(?i)(\.part\d+)?\.(\d{3}|r\d{2})$|\.part\d+$`)
	trackTag     = regexp.MustCompile(`(?i)\s*[\(\[]\s*(track|faixa|trk)\s*\d+\s*[\)\]]`)
	discTag      = regexp.MustCompile(`(?i)\s*[\(\[]\s*(disc|disk|cd|disco|dvd)\s*\d+(\s*(of|de)\s*\d+)?\s*[\)\]]`)
	discSuffix   = regexp.MustCompile(`(?i)[\s_.-]+(disc|disk|cd|disco)[\s_]*\d+$`)
	bareTrack    = regexp.MustCompile(`(?i)^(track|faixa|trk)[\s_-]*\d+$`)
)

// extensions that never decide grouping on their own (covers, saves, patches, subchannel data…)
var sideExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true, ".bmp": true,
	".sav": true, ".srm": true, ".mcr": true, ".sbi": true, ".sub": true, ".lsd": true,
	".ips": true, ".bps": true, ".ups": true, ".xdelta": true, ".pdf": true, ".md": true,
	".sfv": true, ".md5": true, ".sha1": true, ".dat": true, ".xml": true, ".cfg": true, ".ini": true,
}

// game-folder markers: installed/extracted games (PS3, Xbox, Wii U, PC…)
var markerFiles = map[string]bool{
	"param.sfo": true, "eboot.bin": true, "default.xex": true, "default.xbe": true, "system.cnf": true,
	"icon0.png": true, "boot.bin": true, "main.dol": true, "title.tmd": true,
}
var markerDirs = map[string]bool{"ps3_game": true, "usrdir": true, "ps3_update": true, "code": true, "content": true, "meta": true, "sys": true, "files": true}

// stem returns the grouping key (lower case) and the display title of a file name.
func stem(name string) (key, title string) {
	base := multiPartExt.ReplaceAllString(name, "")
	if ext := pathExt(base); ext != "" && len(ext) <= 6 {
		base = strings.TrimSuffix(base, ext)
	}
	base = trackTag.ReplaceAllString(base, "")
	base = discTag.ReplaceAllString(base, "")
	base = discSuffix.ReplaceAllString(base, "")
	base = strings.TrimSpace(strings.Trim(base, " _-."))
	if bareTrack.MatchString(base) {
		base = ""
	}
	return strings.ToLower(base), base
}

// CleanTitle turns a folder or file name into a game title.
func CleanTitle(s string) string {
	_, t := stem(s + ".x")
	if t == "" {
		return strings.TrimSpace(s)
	}
	return t
}

// node is a folder inside a console folder.
type node struct {
	name  string
	files []int // indexes into items
	dirs  map[string]*node
	order []string
}

func (n *node) child(name string) *node {
	if n.dirs == nil {
		n.dirs = map[string]*node{}
	}
	c, ok := n.dirs[name]
	if !ok {
		c = &node{name: name}
		n.dirs[name] = c
		n.order = append(n.order, name)
	}
	return c
}

func (n *node) all(out []int) []int {
	out = append(out, n.files...)
	for _, k := range n.order {
		out = n.dirs[k].all(out)
	}
	return out
}

// DetectGames sets GameKey/GameTitle/GameFolder/GameParts/GameMain/GamePath on every item.
//
// Inside each console folder, a sub-folder is one game when it looks like one (a .cue/.gdi/.m3u
// set, a single game's files, an extracted PS3/Wii U/PC game…); otherwise it is a category
// ("Hacks/", "Traduzidos/") and its files are loose games. Loose files with the same name
// (Game.cue + Game (Track 1).bin, Disc 1/Disc 2) form one game. layout forces either way.
func DetectGames(items []models.RomItem, layout string) {
	roots := map[string]*node{}
	var rootOrder []string
	for i := range items {
		k := items[i].ConsoleDir + "\x00" + items[i].Console
		if items[i].ConsoleDir != "" {
			k = items[i].ConsoleDir
		}
		r, ok := roots[k]
		if !ok {
			r = &node{}
			roots[k] = r
			rootOrder = append(rootOrder, k)
		}
		n := r
		if items[i].RelDir != "" {
			for _, part := range strings.Split(items[i].RelDir, "/") {
				n = n.child(part)
			}
		}
		n.files = append(n.files, i)
	}
	for _, k := range rootOrder {
		prefix := strings.ReplaceAll(k, "\x00", "#")
		var visit func(n *node, dir string, depth int)
		visit = func(n *node, dir string, depth int) {
			looseGames(items, n.files, prefix+"/"+dir)
			for _, name := range n.order {
				c := n.dirs[name]
				sub := strings.TrimPrefix(dir+"/"+name, "/")
				if isGameFolder(items, c, layout, depth) {
					folderGame(items, c, prefix+"/"+sub, sub, name)
				} else {
					visit(c, sub, depth+1)
				}
			}
		}
		visit(roots[k], "", 0)
	}
}

func isGameFolder(items []models.RomItem, n *node, layout string, depth int) bool {
	switch layout {
	case LayoutFolders:
		return depth == 0
	case LayoutLoose:
		return false
	}
	files := n.all(nil)
	if len(files) == 0 {
		return false
	}
	var check func(n *node) bool
	check = func(n *node) bool {
		for _, k := range n.order {
			if markerDirs[strings.ToLower(k)] || check(n.dirs[k]) {
				return true
			}
		}
		return false
	}
	if check(n) {
		return true
	}
	groups := map[string]bool{}
	for _, i := range files {
		nm := strings.ToLower(items[i].Name)
		ext := strings.ToLower(pathExt(nm))
		if markerFiles[nm] || ext == ".exe" || ext == ".rpx" {
			return true
		}
		if sideExt[ext] {
			continue
		}
		key, _ := stem(items[i].Name)
		if key != "" {
			groups[key] = true
		}
	}
	if len(groups) <= 1 {
		return true
	}
	// "Game Name/" whose files all start with the folder name ("Game Name (USA).bin", "Game Name - extras.zip")
	fk, _ := stem(n.name + ".x")
	if fk != "" {
		for g := range groups {
			if !strings.HasPrefix(g, fk) {
				return false
			}
		}
		return true
	}
	return false
}

func folderGame(items []models.RomItem, n *node, key, sub, name string) {
	idx := n.all(nil)
	title := CleanTitle(name)
	for _, i := range idx {
		items[i].GameKey = key
		items[i].GameTitle = title
		items[i].GameFolder = true
		items[i].GameParts = len(idx)
		// path inside the game folder ("PS3_GAME/USRDIR/EBOOT.BIN")
		rel := strings.TrimPrefix(strings.TrimPrefix(items[i].RelDir, sub), "/")
		items[i].GamePath = strings.TrimPrefix(path.Join(rel, items[i].Name), "/")
	}
	markMain(items, idx)
}

func looseGames(items []models.RomItem, idx []int, dirKey string) {
	byKey := map[string][]int{}
	var order []string
	for _, i := range idx {
		key, _ := stem(items[i].Name)
		if key == "" {
			key = "\x00" + strings.ToLower(items[i].Name)
		}
		if _, ok := byKey[key]; !ok {
			order = append(order, key)
		}
		byKey[key] = append(byKey[key], i)
	}
	for _, key := range order {
		g := byKey[key]
		_, title := stem(items[g[0]].Name)
		if title == "" {
			title = items[g[0]].Name
		}
		for _, i := range g {
			items[i].GameKey = strings.TrimSuffix(dirKey, "/") + "/" + strings.TrimPrefix(key, "\x00")
			items[i].GameTitle = title
			items[i].GameFolder = false
			items[i].GameParts = len(g)
			items[i].GamePath = items[i].Name
		}
		markMain(items, g)
	}
}

var mainRank = map[string]int{
	".m3u": 0, ".cue": 1, ".gdi": 1, ".ccd": 2, ".mds": 2, ".cdi": 2,
	".chd": 3, ".iso": 3, ".rvz": 3, ".wbfs": 3, ".gcz": 3, ".nsp": 3, ".xci": 3, ".cso": 3, ".pbp": 3, ".wua": 3, ".3ds": 3, ".cia": 3,
	".exe": 4, ".eboot": 4,
}

// markMain flags the file a launcher should open (m3u > cue/gdi > image > biggest).
func markMain(items []models.RomItem, idx []int) {
	best := -1
	for _, i := range idx {
		items[i].GameMain = false
		if best < 0 {
			best = i
			continue
		}
		ri, rb := rank(items[i]), rank(items[best])
		if ri < rb || (ri == rb && ri < 9 && items[i].Name < items[best].Name) || (ri == rb && ri == 9 && items[i].SizeBytes > items[best].SizeBytes) {
			best = i
		}
	}
	if best >= 0 {
		items[best].GameMain = true
	}
}

func rank(it models.RomItem) int {
	if strings.EqualFold(it.Name, "eboot.bin") {
		return 4
	}
	if r, ok := mainRank[strings.ToLower(it.Extension)]; ok {
		return r
	}
	if sideExt[strings.ToLower(it.Extension)] {
		return 20
	}
	return 9
}

// GameSummary is used by the admin preview.
type GameSummary struct {
	Title  string   `json:"title"`
	Folder bool     `json:"folder"`
	Parts  int      `json:"parts"`
	Bytes  int64    `json:"bytes"`
	Main   string   `json:"main"`
	Files  []string `json:"files,omitempty"`
}

type ConsoleSummary struct {
	Console     string        `json:"console"`
	Files       int           `json:"files"`
	Bytes       int64         `json:"bytes"`
	Games       int           `json:"games"`
	FolderGames int           `json:"folder_games"`
	LooseGames  int           `json:"loose_games"`
	Examples    []GameSummary `json:"examples"`
}

// Summarize groups scanned items per console with up to perConsole example games.
func Summarize(items []models.RomItem, perConsole int) []ConsoleSummary {
	type acc struct {
		s     ConsoleSummary
		games map[string]*GameSummary
		order []string
	}
	m := map[string]*acc{}
	var order []string
	for _, it := range items {
		a, ok := m[it.Console]
		if !ok {
			a = &acc{s: ConsoleSummary{Console: it.Console}, games: map[string]*GameSummary{}}
			m[it.Console] = a
			order = append(order, it.Console)
		}
		a.s.Files++
		a.s.Bytes += it.SizeBytes
		g, ok := a.games[it.GameKey]
		if !ok {
			g = &GameSummary{Title: it.GameTitle, Folder: it.GameFolder}
			a.games[it.GameKey] = g
			a.order = append(a.order, it.GameKey)
		}
		g.Parts++
		g.Bytes += it.SizeBytes
		if it.GameMain {
			g.Main = it.GamePath
		}
		if len(g.Files) < 6 {
			g.Files = append(g.Files, it.GamePath)
		}
	}
	sort.Strings(order)
	out := make([]ConsoleSummary, 0, len(order))
	for _, c := range order {
		a := m[c]
		a.s.Games = len(a.order)
		// show multi-file games first: they are the ones the detection matters for
		keys := append([]string(nil), a.order...)
		sort.SliceStable(keys, func(i, j int) bool { return a.games[keys[i]].Parts > a.games[keys[j]].Parts })
		for _, k := range a.order {
			if a.games[k].Folder {
				a.s.FolderGames++
			} else {
				a.s.LooseGames++
			}
		}
		for i, k := range keys {
			if i >= perConsole {
				break
			}
			a.s.Examples = append(a.s.Examples, *a.games[k])
		}
		out = append(out, a.s)
	}
	return out
}
