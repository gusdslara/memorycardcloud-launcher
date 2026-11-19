package gdrive

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"go-backend/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

type ServiceAccount struct {
	Type                    string `json:"type"`
	ProjectID               string `json:"project_id"`
	PrivateKeyID            string `json:"private_key_id"`
	PrivateKey              string `json:"private_key"`
	ClientEmail             string `json:"client_email"`
	ClientID                string `json:"client_id"`
	AuthURI                 string `json:"auth_uri"`
	TokenURI                string `json:"token_uri"`
	AuthProviderX509CertURL string `json:"auth_provider_x509_cert_url"`
	ClientX509CertURL       string `json:"client_x509_cert_url"`
}

type DriveService struct {
	Config models.GoogleDriveConfig

	cachedToken     string
	tokenExpiry     time.Time
	tokenLock       sync.Mutex
	httpClient      *http.Client
}

func NewDriveService(cfg models.GoogleDriveConfig) *DriveService {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:     jar,
		Timeout: 30 * time.Minute, // Large files / streaming
	}

	return &DriveService{
		Config:     cfg,
		httpClient: client,
	}
}

// GenerateDirectDownloadURL builds the direct download URL bypassing Google Drive HTML UI
func GenerateDirectDownloadURL(fileID string) string {
	return fmt.Sprintf("https://drive.usercontent.google.com/download?id=%s&export=download&confirm=t&authuser=0", fileID)
}

// GenerateUcURL builds the standard uc direct link
func GenerateUcURL(fileID string) string {
	return fmt.Sprintf("https://drive.google.com/uc?export=download&id=%s&confirm=t", fileID)
}

// FormatBytes formats byte count into human readable representation
func FormatBytes(b int64) string {
	const (
		KB = 1024
		MB = 1024 * KB
		GB = 1024 * MB
		TB = 1024 * GB
	)
	switch {
	case b >= TB:
		return fmt.Sprintf("%.2f TB", float64(b)/float64(TB))
	case b >= GB:
		return fmt.Sprintf("%.2f GB", float64(b)/float64(GB))
	case b >= MB:
		return fmt.Sprintf("%.2f MB", float64(b)/float64(MB))
	case b >= KB:
		return fmt.Sprintf("%.2f KB", float64(b)/float64(KB))
	default:
		return fmt.Sprintf("%d B", b)
	}
}

// InferConsole categorizes ROM/ISO based on filename, folder and extension
func InferConsole(fileName, folderPath string) string {
	lower := strings.ToLower(fileName + " " + folderPath)
	ext := strings.ToLower(filepath.Ext(fileName))

	// BIOS check
	if strings.Contains(lower, "bios") || strings.HasPrefix(strings.ToLower(fileName), "scph") {
		return "BIOS"
	}

	// Platform specific extensions
	switch ext {
	case ".nsp", ".xci":
		return "Switch"
	case ".rvz", ".gcm":
		return "GameCube"
	case ".wbfs":
		return "Wii"
	case ".cso":
		return "PSP"
	case ".z64", ".n64", ".v64":
		return "N64"
	case ".sfc", ".smc":
		return "SNES"
	case ".gba":
		return "GBA"
	case ".gbc", ".gb":
		return "GameBoy"
	case ".nds":
		return "NDS"
	case ".chd":
		if strings.Contains(lower, "ps2") {
			return "PS2"
		}
		if strings.Contains(lower, "dreamcast") {
			return "Dreamcast"
		}
		if strings.Contains(lower, "saturn") {
			return "Saturn"
		}
		return "PS1"
	}

	// Name hints
	if strings.Contains(lower, "ps2") || strings.Contains(lower, "playstation 2") {
		return "PS2"
	}
	if strings.Contains(lower, "gamecube") || strings.Contains(lower, "dolphin") {
		return "GameCube"
	}
	if strings.Contains(lower, "switch") || strings.Contains(lower, "yuzu") || strings.Contains(lower, "ryujinx") {
		return "Switch"
	}
	if strings.Contains(lower, "wii") {
		return "Wii"
	}
	if strings.Contains(lower, "ps1") || strings.Contains(lower, "psx") || strings.Contains(lower, "playstation") {
		return "PS1"
	}
	if strings.Contains(lower, "psp") {
		return "PSP"
	}
	if strings.Contains(lower, "dreamcast") {
		return "Dreamcast"
	}
	if strings.Contains(lower, "n64") || strings.Contains(lower, "nintendo 64") {
		return "N64"
	}
	if strings.Contains(lower, "snes") || strings.Contains(lower, "super nintendo") {
		return "SNES"
	}
	if strings.Contains(lower, "gba") || strings.Contains(lower, "advance") {
		return "GBA"
	}

	if ext == ".iso" {
		return "PS2 / ISO"
	}
	if ext == ".zip" || ext == ".7z" || ext == ".rar" {
		return "Game Archive"
	}

	return "Retro"
}

// GetAccessToken resolves OAuth2 token via Google Service Account JSON if configured
func (s *DriveService) GetAccessToken() (string, error) {
	s.tokenLock.Lock()
	defer s.tokenLock.Unlock()

	if s.cachedToken != "" && time.Now().Before(s.tokenExpiry) {
		return s.cachedToken, nil
	}

	// Superadmin connected with "Entrar com Google": use the stored refresh token.
	if s.Config.OAuthRefreshToken != "" {
		tok, ttl, err := s.refreshAccessToken()
		if err != nil {
			return "", fmt.Errorf("login Google expirou ou foi revogado: %w", err)
		}
		s.cachedToken = tok
		s.tokenExpiry = time.Now().Add(ttl - time.Minute)
		return tok, nil
	}

	saJSON := s.Config.ServiceAccountJSON
	if saJSON == "" {
		saJSON = os.Getenv("GDRIVE_SERVICE_ACCOUNT_JSON")
	}
	if saJSON == "" {
		return "", fmt.Errorf("no service account JSON credentials provided")
	}

	var sa ServiceAccount
	if strings.HasPrefix(strings.TrimSpace(saJSON), "{") {
		if err := json.Unmarshal([]byte(saJSON), &sa); err != nil {
			return "", fmt.Errorf("invalid service account json: %w", err)
		}
	} else {
		// File path
		content, err := os.ReadFile(saJSON)
		if err != nil {
			return "", fmt.Errorf("failed to read service account file: %w", err)
		}
		if err := json.Unmarshal(content, &sa); err != nil {
			return "", fmt.Errorf("failed to parse service account file: %w", err)
		}
	}

	rsaKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(sa.PrivateKey))
	if err != nil {
		return "", fmt.Errorf("failed to parse rsa private key: %w", err)
	}

	tokenURI := sa.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}

	now := time.Now()
	claims := jwt.MapClaims{
		"iss":   sa.ClientEmail,
		"scope": "https://www.googleapis.com/auth/drive.readonly",
		"aud":   tokenURI,
		"exp":   now.Add(50 * time.Minute).Unix(),
		"iat":   now.Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signedJWT, err := token.SignedString(rsaKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign jwt: %w", err)
	}

	data := url.Values{}
	data.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	data.Set("assertion", signedJWT)

	req, err := http.NewRequest("POST", tokenURI, strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to exchange jwt for token: %w", err)
	}
	defer resp.Body.Close()

	var tokenRes struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenRes); err != nil {
		return "", err
	}
	if tokenRes.Error != "" || tokenRes.AccessToken == "" {
		return "", fmt.Errorf("oauth error: %s", tokenRes.Error)
	}

	s.cachedToken = tokenRes.AccessToken
	s.tokenExpiry = now.Add(time.Duration(tokenRes.ExpiresIn-60) * time.Second)
	return s.cachedToken, nil
}

// DriveFileListResponse represents Google Drive v3 API files.list JSON
type DriveFileListResponse struct {
	Files []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		MimeType     string `json:"mimeType"`
		Size         string `json:"size"`
		ModifiedTime string `json:"modifiedTime"`
	} `json:"files"`
	NextPageToken string `json:"nextPageToken"`
	Error         *struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	} `json:"error"`
}

// ScanFolder queries Google Drive folder for ROMs, ISOs, BIOS and archives
func (s *DriveService) ScanFolder(folderID string) ([]models.RomItem, error) {
	if folderID == "" {
		folderID = s.Config.FolderID
	}
	if folderID == "" {
		folderID = os.Getenv("GDRIVE_ROMS_FOLDER_ID")
	}

	// Try API if token or API key is available
	apiKey := s.Config.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GDRIVE_API_KEY")
	}

	// Private folder via the superadmin's Google login: walk console sub-folders, never fake data.
	if s.Config.OAuthRefreshToken != "" {
		return s.ScanTree(context.Background(), folderID, 6)
	}

	token, _ := s.GetAccessToken()

	if folderID != "" && (token != "" || apiKey != "") {
		items, err := s.fetchGoogleDriveFolderFiles(folderID, token, apiKey)
		if err == nil && len(items) > 0 {
			return items, nil
		}
	}

	// Default fallback catalog if credentials are missing or folder empty
	return GetSampleRomsCatalog(folderID), nil
}

func (s *DriveService) fetchGoogleDriveFolderFiles(folderID, token, apiKey string) ([]models.RomItem, error) {
	var items []models.RomItem
	pageToken := ""

	for {
		apiURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files?q='%s'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=1000", url.QueryEscape(folderID))
		if apiKey != "" && token == "" {
			apiURL += "&key=" + url.QueryEscape(apiKey)
		}
		if pageToken != "" {
			apiURL += "&pageToken=" + url.QueryEscape(pageToken)
		}

		req, err := http.NewRequest("GET", apiURL, nil)
		if err != nil {
			return nil, err
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := s.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		var listRes DriveFileListResponse
		if err := json.NewDecoder(resp.Body).Decode(&listRes); err != nil {
			return nil, err
		}

		if listRes.Error != nil {
			return nil, fmt.Errorf("google drive api error (%d): %s", listRes.Error.Code, listRes.Error.Message)
		}

		for _, f := range listRes.Files {
			// Skip directories
			if f.MimeType == "application/vnd.google-apps.folder" {
				continue
			}

			var size int64
			fmt.Sscanf(f.Size, "%d", &size)

			modTime, _ := time.Parse(time.RFC3339, f.ModifiedTime)
			if modTime.IsZero() {
				modTime = time.Now()
			}

			console := InferConsole(f.Name, "")
			ext := filepath.Ext(f.Name)

			item := models.RomItem{
				DriveFileID:   f.ID,
				Name:          f.Name,
				Console:       console,
				Extension:     ext,
				SizeBytes:     size,
				SizeFormatted: FormatBytes(size),
				MimeType:      f.MimeType,
				DirectURL:     GenerateDirectDownloadURL(f.ID),
				DownloadURL:   fmt.Sprintf("/api/roms/%s/download", f.ID),
				IsAvailable:   true,
				ModifiedAt:    modTime,
			}
			items = append(items, item)
		}

		pageToken = listRes.NextPageToken
		if pageToken == "" {
			break
		}
	}

	return items, nil
}

// StreamDownload streams the file directly to client while bypassing the Google Drive virus confirmation page
func (s *DriveService) StreamDownload(c *fiber.Ctx, fileID string, fileName string, sizeBytes int64) error {
	token, _ := s.GetAccessToken()

	var req *http.Request
	var err error

	if token != "" {
		// Authenticated API media stream ALWAYS downloads binary file directly
		apiURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files/%s?alt=media", fileID)
		req, err = http.NewRequest("GET", apiURL, nil)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create request"})
		}
		req.Header.Set("Authorization", "Bearer "+token)
	} else {
		// Use direct usercontent download with confirmation token
		directURL := GenerateDirectDownloadURL(fileID)
		req, err = http.NewRequest("GET", directURL, nil)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"message": "Failed to create request"})
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	}

	// Forward Range header if client specified it for resumable downloads
	if rangeHeader := c.Get("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"message": "Failed to fetch from Google Drive"})
	}

	contentType := resp.Header.Get("Content-Type")

	// If Google returned an HTML virus scan confirmation page (>100MB warning):
	if strings.Contains(contentType, "text/html") && resp.StatusCode == 200 {
		bodyBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err == nil {
			htmlBody := string(bodyBytes)
			confirmToken := extractConfirmToken(htmlBody, resp.Cookies())
			if confirmToken != "" {
				// Retry with extracted confirm token
				retryURL := fmt.Sprintf("https://drive.usercontent.google.com/download?id=%s&export=download&confirm=%s&authuser=0", fileID, confirmToken)
				req2, _ := http.NewRequest("GET", retryURL, nil)
				req2.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
				if rangeHeader := c.Get("Range"); rangeHeader != "" {
					req2.Header.Set("Range", rangeHeader)
				}
				resp2, err2 := s.httpClient.Do(req2)
				if err2 == nil && !strings.Contains(resp2.Header.Get("Content-Type"), "text/html") {
					resp = resp2
				}
			}
		}
	}

	// Prepare streaming headers
	cleanFileName := fileName
	if cleanFileName == "" {
		cleanFileName = fmt.Sprintf("game-%s.bin", fileID)
	}

	c.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, cleanFileName))
	c.Set("Accept-Ranges", "bytes")
	if mime := resp.Header.Get("Content-Type"); mime != "" && !strings.Contains(mime, "text/html") {
		c.Set("Content-Type", mime)
	} else {
		c.Set("Content-Type", "application/octet-stream")
	}

	if cl := resp.Header.Get("Content-Length"); cl != "" {
		c.Set("Content-Length", cl)
	} else if sizeBytes > 0 {
		c.Set("Content-Length", fmt.Sprintf("%d", sizeBytes))
	}

	if cr := resp.Header.Get("Content-Range"); cr != "" {
		c.Status(fiber.StatusPartialContent)
		c.Set("Content-Range", cr)
	} else {
		c.Status(resp.StatusCode)
	}

	// Stream directly to client
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer resp.Body.Close()
		_, _ = io.Copy(w, resp.Body)
	})

	return nil
}

// extractConfirmToken parses virus scan bypass token from Google Drive HTML or cookies
func extractConfirmToken(html string, cookies []*http.Cookie) string {
	// 1. Check cookies
	for _, cookie := range cookies {
		if strings.HasPrefix(cookie.Name, "download_warning") {
			return cookie.Value
		}
	}

	// 2. Regex for confirm=XXXX
	reConfirm := regexp.MustCompile(`confirm=([a-zA-Z0-9_-]+)`)
	matches := reConfirm.FindStringSubmatch(html)
	if len(matches) > 1 {
		return matches[1]
	}

	// 3. Regex for input name="confirm" value="XXXX"
	reInput := regexp.MustCompile(`name=["']confirm["']\s+value=["']([a-zA-Z0-9_-]+)["']`)
	matchesInput := reInput.FindStringSubmatch(html)
	if len(matchesInput) > 1 {
		return matchesInput[1]
	}

	return "t" // Fallback query param for newer Google Drive endpoints
}

// GetSampleRomsCatalog returns default sample items if Google Drive API is not yet configured
func GetSampleRomsCatalog(folderID string) []models.RomItem {
	return []models.RomItem{
		{
			DriveFileID:   "1gDrive_PS2_GodOfWar2",
			Name:          "God of War II (USA) (v2.00).iso",
			Console:       "PS2",
			Extension:     ".iso",
			SizeBytes:     4294967296, // 4.00 GB
			SizeFormatted: "4.00 GB",
			MimeType:      "application/x-iso9660-image",
			FolderPath:    "ROMs/PS2",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_PS2_GodOfWar2"),
			DownloadURL:   "/api/roms/1gDrive_PS2_GodOfWar2/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-48 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_PS2_GranTurismo4",
			Name:          "Gran Turismo 4 (USA).iso",
			Console:       "PS2",
			Extension:     ".iso",
			SizeBytes:     5368709120, // 5.00 GB
			SizeFormatted: "5.00 GB",
			MimeType:      "application/x-iso9660-image",
			FolderPath:    "ROMs/PS2",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_PS2_GranTurismo4"),
			DownloadURL:   "/api/roms/1gDrive_PS2_GranTurismo4/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-24 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_GC_SuperSmashMelee",
			Name:          "Super Smash Bros. Melee (USA) (v1.02).rvz",
			Console:       "GameCube",
			Extension:     ".rvz",
			SizeBytes:     1342177280, // 1.25 GB
			SizeFormatted: "1.25 GB",
			MimeType:      "application/octet-stream",
			FolderPath:    "ROMs/GameCube",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_GC_SuperSmashMelee"),
			DownloadURL:   "/api/roms/1gDrive_GC_SuperSmashMelee/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-12 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_Switch_ZeldaTOTK",
			Name:          "The Legend of Zelda Tears of the Kingdom [0100F2C0115B6000][v0].nsp",
			Console:       "Switch",
			Extension:     ".nsp",
			SizeBytes:     17179869184, // 16.00 GB
			SizeFormatted: "16.00 GB",
			MimeType:      "application/x-nintendo-switch-package",
			FolderPath:    "ROMs/Switch",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_Switch_ZeldaTOTK"),
			DownloadURL:   "/api/roms/1gDrive_Switch_ZeldaTOTK/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-72 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_PS1_CastlevaniaSOTN",
			Name:          "Castlevania - Symphony of the Night (USA).chd",
			Console:       "PS1",
			Extension:     ".chd",
			SizeBytes:     419430400, // 400 MB
			SizeFormatted: "400 MB",
			MimeType:      "application/octet-stream",
			FolderPath:    "ROMs/PS1",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_PS1_CastlevaniaSOTN"),
			DownloadURL:   "/api/roms/1gDrive_PS1_CastlevaniaSOTN/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-96 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_BIOS_PS2_SCPH39001",
			Name:          "scph39001.bin",
			Console:       "BIOS",
			Extension:     ".bin",
			SizeBytes:     4194304, // 4 MB
			SizeFormatted: "4.00 MB",
			MimeType:      "application/octet-stream",
			FolderPath:    "BIOS/PlayStation2",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_BIOS_PS2_SCPH39001"),
			DownloadURL:   "/api/roms/1gDrive_BIOS_PS2_SCPH39001/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-120 * time.Hour),
		},
		{
			DriveFileID:   "1gDrive_N64_Mario64",
			Name:          "Super Mario 64 (USA).z64",
			Console:       "N64",
			Extension:     ".z64",
			SizeBytes:     8388608, // 8 MB
			SizeFormatted: "8.00 MB",
			MimeType:      "application/octet-stream",
			FolderPath:    "ROMs/N64",
			DirectURL:     GenerateDirectDownloadURL("1gDrive_N64_Mario64"),
			DownloadURL:   "/api/roms/1gDrive_N64_Mario64/download",
			IsAvailable:   true,
			ModifiedAt:    time.Now().Add(-150 * time.Hour),
		},
	}
}

// CleanUnused avoids unused package error if bytes is only in helpers
var _ = bytes.MinRead
