// Package cast provides API client helpers for talking to the Kimchi/CAST AI
// remote-session backend: credential verification, session resolution, and token
// exchange.
package cast

import (
	"bytes"
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

const httpTimeout = 30 * time.Second

// ─── Errors ───────────────────────────────────────────────────────────────────

// RemoteAuthError is returned when the server responds with an
// authentication/authorisation failure (HTTP 401, 403, 404).
type RemoteAuthError struct {
	Msg    string
	Status int
}

func (e *RemoteAuthError) Error() string { return e.Msg }

// RemoteNetworkError is returned for unexpected HTTP status codes or
// non-JSON responses.
type RemoteNetworkError struct {
	Msg string
}

func (e *RemoteNetworkError) Error() string { return e.Msg }

// ─── Credentials ──────────────────────────────────────────────────────────────

// organizationHeader must match GATEWAY_ORGANIZATION_HEADER in
// src/auth/gateway-credentials.ts.
const organizationHeader = "X-CastAi-Organization-Id"

// Credentials is a bearer token plus the SSO organization it acts in. An SSO
// token without the organization header resolves to the user's default
// organization, so workspace lookups in any other organization miss.
type Credentials struct {
	Token          string
	OrganizationID string
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

func doRequest(ctx context.Context, method, u string, creds Credentials, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+creds.Token)
	if creds.OrganizationID != "" {
		req.Header.Set(organizationHeader, creds.OrganizationID)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, &RemoteNetworkError{Msg: err.Error()}
	}
	return resp, nil
}

func checkResponse(resp *http.Response, endpoint string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	switch resp.StatusCode {
	case 401:
		return &RemoteAuthError{
			Msg:    fmt.Sprintf("Invalid credentials (API key or SSO token). Run `kimchi` and sign in again: %s", endpoint),
			Status: 401,
		}
	case 403:
		return &RemoteAuthError{
			Msg:    fmt.Sprintf("Forbidden: your credentials do not have permission to use remote workspaces. %s", endpoint),
			Status: 403,
		}
	case 404:
		return &RemoteAuthError{
			Msg:    fmt.Sprintf("Workspace not found or endpoint not available. %s", endpoint),
			Status: 404,
		}
	default:
		suffix := ""
		if len(body) > 0 {
			suffix = ": " + string(body)
		}
		return &RemoteNetworkError{
			Msg: fmt.Sprintf("HTTP %d from %s%s", resp.StatusCode, endpoint, suffix),
		}
	}
}

// ─── Workspace helpers ──────────────────────────────────────────────────────────

type workspaceItem struct {
	ID  string `json:"id"`
	URI string `json:"uri"`
}

type listWorkspacesPage struct {
	Items          []workspaceItem `json:"items"`
	NextPageCursor string          `json:"nextPageCursor"`
}

func findWorkspaceIDByURI(ctx context.Context, orgID, sandboxURL string, creds Credentials, endpoint string) (string, error) {
	// fetchPage fetches one page of workspace and returns the items and next cursor.
	// Returns (nil, "", err) on failure.
	fetchPage := func(cursor string) ([]workspaceItem, string, error) {
		qs := ""
		if cursor != "" {
			qs = "?page.cursor=" + url.QueryEscape(cursor)
		}
		u := fmt.Sprintf("%s/ai-optimizer/v1beta/organizations/%s/workspaces%s",
			endpoint, url.PathEscape(orgID), qs)

		reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
		defer cancel()
		resp, err := doRequest(reqCtx, http.MethodGet, u, creds, nil)
		if err != nil {
			return nil, "", err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, "", err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			switch resp.StatusCode {
			case 401:
				return nil, "", &RemoteAuthError{
					Msg:    fmt.Sprintf("Invalid credentials (API key or SSO token). Run `kimchi` and sign in again: %s", endpoint),
					Status: 401,
				}
			case 403:
				return nil, "", &RemoteAuthError{
					Msg:    fmt.Sprintf("Forbidden: your credentials do not have permission to list workspaces. %s", endpoint),
					Status: 403,
				}
			default:
				suffix := ""
				if len(body) > 0 {
					suffix = ": " + string(body)
				}
				return nil, "", &RemoteNetworkError{
					Msg: fmt.Sprintf("HTTP %d from %s%s", resp.StatusCode, u, suffix),
				}
			}
		}
		var page listWorkspacesPage
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, "", &RemoteNetworkError{Msg: fmt.Sprintf("Unexpected non-JSON response from %s", u)}
		}
		return page.Items, page.NextPageCursor, nil
	}

	cursor := ""
	for {
		items, next, err := fetchPage(cursor)
		if err != nil {
			return "", err
		}
		for _, s := range items {
			if s.URI == sandboxURL {
				return s.ID, nil
			}
		}
		cursor = next
		if cursor == "" {
			break
		}
	}
	return "", &RemoteAuthError{
		Msg:    fmt.Sprintf("No workspace found with URI '%s'.", sandboxURL),
		Status: 404,
	}
}

func fetchWorkspaceByID(ctx context.Context, orgID, workspaceID string, creds Credentials, endpoint string) (string, error) {
	u := fmt.Sprintf("%s/ai-optimizer/v1beta/organizations/%s/workspaces/%s",
		endpoint, url.PathEscape(orgID), url.PathEscape(workspaceID))
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodGet, u, creds, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, u); err != nil {
		return "", err
	}
	var data struct {
		URI string `json:"uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Unexpected non-JSON response from %s", u)}
	}
	if data.URI == "" {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Missing uri in workspace response from %s", u)}
	}
	return data.URI, nil
}

// ─── Config / credentials ────────────────────────────────────────────────────────

// DefaultEndpoint is the US region's API origin. The tool is region-unaware —
// other regions are reached via KIMCHI_REMOTE_ENDPOINT (see ResolveEndpoint).
const DefaultEndpoint = "https://api.cast.ai"

// ReadCredentials returns the bearer (KIMCHI_API_KEY: an API key or an SSO
// token) and the optional SSO organization (KIMCHI_ORGANIZATION_ID) from the
// environment.
func ReadCredentials() (Credentials, error) {
	k := os.Getenv("KIMCHI_API_KEY")
	if k == "" {
		return Credentials{}, errors.New("KIMCHI_API_KEY environment variable is not set")
	}
	return Credentials{Token: k, OrganizationID: os.Getenv("KIMCHI_ORGANIZATION_ID")}, nil
}

// ResolveEndpoint returns the API endpoint, falling back to DefaultEndpoint.
func ResolveEndpoint() string {
	if e := os.Getenv("KIMCHI_REMOTE_ENDPOINT"); e != "" {
		return e
	}
	return DefaultEndpoint
}

// ─── Public API ───────────────────────────────────────────────────────────────

// VerifyCredentials validates the credentials against the endpoint and returns the
// organisation ID they act in.
func VerifyCredentials(ctx context.Context, creds Credentials, endpoint string) (string, error) {
	u := endpoint + "/ai-optimizer/v1beta/workspace-tokens:verifyKey"
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodPost, u, creds, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, u); err != nil {
		return "", err
	}
	var data struct {
		OrganizationID string `json:"organizationId"`
		UserID         string `json:"userID"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Unexpected non-JSON response from %s", endpoint)}
	}
	if data.OrganizationID == "" {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Missing organizationId in verify response from %s", endpoint)}
	}
	return data.OrganizationID, nil
}

// ResolveWorkspaceID returns the workspace ID and sandbox URI for the given arg.
// If arg contains a '.', it is treated as a sandbox URL and the workspace list
// is searched to find the matching ID. Otherwise arg is treated directly as a
// workspace ID and the workspace is fetched by ID to obtain its URI.
func ResolveWorkspaceID(ctx context.Context, orgID, workspaceIDOrSandboxURL string, creds Credentials, endpoint string) (workspaceID, sandboxURL string, err error) {
	if strings.Contains(workspaceIDOrSandboxURL, ".") {
		id, err := findWorkspaceIDByURI(ctx, orgID, workspaceIDOrSandboxURL, creds, endpoint)
		return id, workspaceIDOrSandboxURL, err
	}
	uri, err := fetchWorkspaceByID(ctx, orgID, workspaceIDOrSandboxURL, creds, endpoint)
	return workspaceIDOrSandboxURL, uri, err
}

// ExchangeWorkspaceToken exchanges a workspace ID for a short-lived bearer token.
func ExchangeWorkspaceToken(ctx context.Context, creds Credentials, workspaceID, endpoint string) (string, error) {
	u := endpoint + "/ai-optimizer/v1beta/workspace-tokens:exchange"
	bodyBytes, _ := json.Marshal(map[string]string{"workspaceId": workspaceID})
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodPost, u, creds, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, u); err != nil {
		return "", err
	}
	var data struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Unexpected non-JSON response from %s", endpoint)}
	}
	if data.Token == "" {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Missing token in exchange response from %s", endpoint)}
	}
	return data.Token, nil
}
