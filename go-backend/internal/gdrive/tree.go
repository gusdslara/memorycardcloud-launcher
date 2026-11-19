package gdrive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go-backend/models"
)

const folderMime = "application/vnd.google-apps.folder"

type DriveFolder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type driveFile struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MimeType     string `json:"mimeType"`
	Size         string `json:"size"`
	ModifiedTime string `json:"modifiedTime"`
	MD5          string `json:"md5Checksum"`
}

// noTimeout is used for big media downloads (ISOs take longer than any fixed timeout); ctx cancels them.
var noTimeout = &http.Client{}

func (s *DriveService) authed(ctx context.Context, method, rawURL string) (*http.Response, error) {
	return s.authedWith(ctx, s.httpClient, method, rawURL)
}

func (s *DriveService) authedWith(ctx context.Context, client *http.Client, method, rawURL string) (*http.Response, error) {
	token, err := s.GetAccessToken()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return client.Do(req)
}

// list returns every child of a folder (all pages).
func (s *DriveService) list(ctx context.Context, q string) ([]driveFile, error) {
	var out []driveFile
	page := ""
	for {
		v := url.Values{
			"q":                         {q},
			"fields":                    {"nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)"},
			"pageSize":                  {"1000"},
			"orderBy":                   {"folder,name"},
			"supportsAllDrives":         {"true"},
			"includeItemsFromAllDrives": {"true"},
		}
		if page != "" {
			v.Set("pageToken", page)
		}
		resp, err := s.authed(ctx, http.MethodGet, DriveAPI+"/files?"+v.Encode())
		if err != nil {
			return nil, err
		}
		var body struct {
			Files         []driveFile `json:"files"`
			NextPageToken string      `json:"nextPageToken"`
			Error         *struct {
				Message string `json:"message"`
				Code    int    `json:"code"`
			} `json:"error"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&body)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if body.Error != nil {
			return nil, fmt.Errorf("google drive (%d): %s", body.Error.Code, body.Error.Message)
		}
		out = append(out, body.Files...)
		if body.NextPageToken == "" {
			return out, nil
		}
		page = body.NextPageToken
	}
}

func escapeQ(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `'`, `\'`) }

// ListFolders lists sub-folders of parent ("root" = My Drive). With search, finds folders by name anywhere.
func (s *DriveService) ListFolders(ctx context.Context, parent, search string) ([]DriveFolder, error) {
	q := fmt.Sprintf("mimeType='%s' and trashed=false", folderMime)
	if strings.TrimSpace(search) != "" {
		q += fmt.Sprintf(" and name contains '%s'", escapeQ(strings.TrimSpace(search)))
	} else {
		if parent == "" {
			parent = "root"
		}
		q += fmt.Sprintf(" and '%s' in parents", escapeQ(parent))
	}
	files, err := s.list(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]DriveFolder, 0, len(files))
	for _, f := range files {
		out = append(out, DriveFolder{ID: f.ID, Name: f.Name})
	}
	return out, nil
}

// FolderName returns the display name of a folder id.
func (s *DriveService) FolderName(ctx context.Context, id string) (string, error) {
	resp, err := s.authed(ctx, http.MethodGet, DriveAPI+"/files/"+url.PathEscape(id)+"?fields=id,name,mimeType&supportsAllDrives=true")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var f driveFile
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&f); err != nil || f.ID == "" {
		return "", fmt.Errorf("pasta não encontrada (%d)", resp.StatusCode)
	}
	if f.MimeType != folderMime {
		return "", errors.New("o item escolhido não é uma pasta")
	}
	return f.Name, nil
}

// ScanTree walks the "roms" folder: each first-level sub-folder is a console
// (PS2/, Nintendo 64/, GameCube/…), deeper folders are kept in FolderPath.
func (s *DriveService) ScanTree(ctx context.Context, rootID string, maxDepth int) ([]models.RomItem, error) {
	if rootID == "" {
		return nil, errors.New("nenhuma pasta escolhida")
	}
	var items []models.RomItem
	var walk func(id, path, console string, depth int) error
	walk = func(id, path, console string, depth int) error {
		files, err := s.list(ctx, fmt.Sprintf("'%s' in parents and trashed=false", escapeQ(id)))
		if err != nil {
			return err
		}
		for _, f := range files {
			if f.MimeType == folderMime {
				if depth >= maxDepth {
					continue
				}
				c := console
				if depth == 0 {
					c = ConsoleFromFolder(f.Name)
				}
				if err := walk(f.ID, strings.TrimPrefix(path+"/"+f.Name, "/"), c, depth+1); err != nil {
					return err
				}
				continue
			}
			if strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") || ignoredFile(f.Name) {
				continue // Google Docs/Sheets, shortcuts, desktop.ini…
			}
			var size int64
			fmt.Sscanf(f.Size, "%d", &size)
			mod, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			if mod.IsZero() {
				mod = time.Now()
			}
			cons := console
			if cons == "" || strings.Contains(strings.ToLower(f.Name), "bios") {
				cons = InferConsole(f.Name, path)
			}
			items = append(items, models.RomItem{
				DriveFileID:   f.ID,
				Name:          f.Name,
				Console:       cons,
				Extension:     strings.ToLower(filepath.Ext(f.Name)),
				SizeBytes:     size,
				SizeFormatted: FormatBytes(size),
				MimeType:      f.MimeType,
				FolderPath:    path,
				DownloadURL:   fmt.Sprintf("/api/roms/%s/download", f.ID),
				IsAvailable:   true,
				ModifiedAt:    mod,
			})
		}
		return nil
	}
	if err := walk(rootID, "", "", 0); err != nil {
		return nil, err
	}
	return items, nil
}

func ignoredFile(name string) bool {
	n := strings.ToLower(name)
	return n == "desktop.ini" || n == "thumbs.db" || n == ".ds_store" || strings.HasSuffix(n, ".txt") || strings.HasSuffix(n, ".nfo") || strings.HasSuffix(n, ".url")
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// ConsoleFromFolder maps a console folder name to the short code used by the vault
// (same codes as InferConsole). Unknown names are kept as written.
func ConsoleFromFolder(name string) string {
	k := nonAlnum.ReplaceAllString(strings.ToLower(name), "")
	switch k {
	case "ps1", "psx", "psone", "playstation", "playstation1", "sonyplaystation":
		return "PS1"
	case "ps2", "playstation2", "sonyplaystation2":
		return "PS2"
	case "ps3", "playstation3":
		return "PS3"
	case "ps4", "playstation4":
		return "PS4"
	case "psp", "playstationportable":
		return "PSP"
	case "psvita", "vita", "playstationvita":
		return "Vita"
	case "n64", "nintendo64":
		return "N64"
	case "snes", "supernintendo", "supernes", "sfc", "superfamicom":
		return "SNES"
	case "nes", "nintendo", "famicom":
		return "NES"
	case "gc", "ngc", "gamecube", "nintendogamecube":
		return "GameCube"
	case "wii", "nintendowii":
		return "Wii"
	case "wiiu", "nintendowiiu":
		return "Wii U"
	case "switch", "nintendoswitch", "nsw":
		return "Switch"
	case "gba", "gameboyadvance":
		return "GBA"
	case "gb", "gbc", "gameboy", "gameboycolor":
		return "GameBoy"
	case "nds", "ds", "nintendods":
		return "NDS"
	case "3ds", "n3ds", "nintendo3ds":
		return "3DS"
	case "dc", "dreamcast", "segadreamcast":
		return "Dreamcast"
	case "saturn", "segasaturn":
		return "Saturn"
	case "md", "megadrive", "genesis", "segagenesis", "segamegadrive":
		return "Mega Drive"
	case "segacd", "megacd":
		return "Sega CD"
	case "xbox", "xboxoriginal", "microsoftxbox":
		return "Xbox"
	case "xbox360", "x360":
		return "Xbox 360"
	case "pc", "dos", "windows":
		return "PC"
	case "bios", "bioses", "firmware", "keys":
		return "BIOS"
	}
	return strings.TrimSpace(name)
}

// DownloadToFile copies a Drive file to dest (via dest+".part", renamed at the end).
// progress is called with bytes written so far.
func (s *DriveService) DownloadToFile(ctx context.Context, fileID, dest string, progress func(int64)) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, err
	}
	resp, err := s.authedWith(ctx, noTimeout, http.MethodGet, DriveAPI+"/files/"+url.PathEscape(fileID)+"?alt=media&supportsAllDrives=true&acknowledgeAbuse=true")
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return 0, fmt.Errorf("google drive respondeu %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return 0, err
	}
	var written int64
	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(part)
				return written, werr
			}
			written += int64(n)
			if progress != nil {
				progress(written)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(part)
			return written, rerr
		}
	}
	if err := f.Close(); err != nil {
		os.Remove(part)
		return written, err
	}
	if err := os.Rename(part, dest); err != nil {
		os.Remove(part)
		return written, err
	}
	return written, nil
}

// Quota is the Google account storage (Drive + Gmail + Photos share it).
type Quota struct {
	Email        string `json:"email"`
	Limit        int64  `json:"limit"` // 0 = unlimited (Workspace pooled storage)
	Usage        int64  `json:"usage"`
	UsageInDrive int64  `json:"usage_in_drive"`
	UsageInTrash int64  `json:"usage_in_trash"`
	Free         int64  `json:"free"`
}

// StorageQuota reads the connected account's storage (about.storageQuota).
func (s *DriveService) StorageQuota(ctx context.Context) (Quota, error) {
	resp, err := s.authed(ctx, http.MethodGet, DriveAPI+"/about?fields=storageQuota,user(emailAddress)")
	if err != nil {
		return Quota{}, err
	}
	defer resp.Body.Close()
	var body struct {
		StorageQuota struct {
			Limit             string `json:"limit"`
			Usage             string `json:"usage"`
			UsageInDrive      string `json:"usageInDrive"`
			UsageInDriveTrash string `json:"usageInDriveTrash"`
		} `json:"storageQuota"`
		User struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"user"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return Quota{}, err
	}
	if body.Error != nil {
		return Quota{}, errors.New(body.Error.Message)
	}
	n := func(s string) int64 {
		var v int64
		fmt.Sscanf(s, "%d", &v)
		return v
	}
	q := Quota{
		Email:        body.User.EmailAddress,
		Limit:        n(body.StorageQuota.Limit),
		Usage:        n(body.StorageQuota.Usage),
		UsageInDrive: n(body.StorageQuota.UsageInDrive),
		UsageInTrash: n(body.StorageQuota.UsageInDriveTrash),
	}
	if q.Limit > 0 {
		q.Free = q.Limit - q.Usage
		if q.Free < 0 {
			q.Free = 0
		}
	}
	return q, nil
}
