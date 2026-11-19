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
	"strings"
	"time"
)

// Google login of the superadmin: authorization-code flow with offline access, so the
// server keeps a refresh token and can read the private "roms" folder on its own.
const (
	googleAuthURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL    = "https://oauth2.googleapis.com/token"
	googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
	googleRevokeURL   = "https://oauth2.googleapis.com/revoke"
	// Read-only: the server never changes anything in the Drive.
	DriveScope = "https://www.googleapis.com/auth/drive.readonly"
)

// Endpoints can be swapped in tests.
var (
	TokenEndpoint    = googleTokenURL
	UserInfoEndpoint = googleUserInfoURL
	DriveAPI         = "https://www.googleapis.com/drive/v3"
)

type OAuthClient struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

// OAuthFromEnv reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (Google Cloud → Credentials →
// OAuth client "Web application"). redirectURL must be registered in that client.
func OAuthFromEnv(redirectURL string) (OAuthClient, error) {
	c := OAuthClient{
		ClientID:     strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID")),
		ClientSecret: strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET")),
		RedirectURL:  redirectURL,
	}
	if c.ClientID == "" || c.ClientSecret == "" {
		return c, errors.New("GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não configurados no servidor")
	}
	return c, nil
}

// AuthCodeURL is where the superadmin is sent to log in with Google.
func (o OAuthClient) AuthCodeURL(state, loginHint string) string {
	q := url.Values{
		"client_id":              {o.ClientID},
		"redirect_uri":           {o.RedirectURL},
		"response_type":          {"code"},
		"scope":                  {"openid email " + DriveScope + " " + DriveFileScope}, // drive.file: users' backups (backup.go)
		"access_type":            {"offline"},
		"prompt":                 {"consent"}, // always returns a refresh token
		"include_granted_scopes": {"true"},
		"state":                  {state},
	}
	if loginHint != "" {
		q.Set("login_hint", loginHint)
	}
	return googleAuthURL + "?" + q.Encode()
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func postToken(ctx context.Context, client *http.Client, form url.Values) (tokenResponse, error) {
	var out tokenResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return out, fmt.Errorf("resposta inválida do Google (%d)", resp.StatusCode)
	}
	if out.Error != "" || out.AccessToken == "" {
		return out, fmt.Errorf("google: %s %s", out.Error, out.ErrorDesc)
	}
	return out, nil
}

// Exchange trades the authorization code for tokens and returns (refreshToken, accessToken, email).
func (o OAuthClient) Exchange(ctx context.Context, code string) (refresh, access, email string, err error) {
	client := &http.Client{Timeout: 30 * time.Second}
	tok, err := postToken(ctx, client, url.Values{
		"code":          {code},
		"client_id":     {o.ClientID},
		"client_secret": {o.ClientSecret},
		"redirect_uri":  {o.RedirectURL},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return "", "", "", err
	}
	if tok.RefreshToken == "" {
		return "", "", "", errors.New("o Google não devolveu refresh token; remova o acesso do app em myaccount.google.com/permissions e conecte de novo")
	}
	if !strings.Contains(tok.Scope, DriveScope) {
		return "", "", "", errors.New("a permissão de leitura do Google Drive não foi concedida")
	}
	email, _ = fetchEmail(ctx, client, tok.AccessToken)
	return tok.RefreshToken, tok.AccessToken, email, nil
}

func fetchEmail(ctx context.Context, client *http.Client, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, UserInfoEndpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var body struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body)
	return body.Email, nil
}

// Revoke invalidates the refresh token at Google (best effort).
func Revoke(token string) {
	if token == "" {
		return
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.PostForm(googleRevokeURL, url.Values{"token": {token}})
	if err == nil {
		resp.Body.Close()
	}
}

// refreshAccessToken is used by GetAccessToken when the config holds an OAuth refresh token.
func (s *DriveService) refreshAccessToken() (string, time.Duration, error) {
	o, err := OAuthFromEnv("")
	if err != nil {
		return "", 0, err
	}
	tok, err := postToken(context.Background(), &http.Client{Timeout: 30 * time.Second}, url.Values{
		"client_id":     {o.ClientID},
		"client_secret": {o.ClientSecret},
		"refresh_token": {s.Config.OAuthRefreshToken},
		"grant_type":    {"refresh_token"},
	})
	if err != nil {
		return "", 0, err
	}
	return tok.AccessToken, time.Duration(tok.ExpiresIn) * time.Second, nil
}
