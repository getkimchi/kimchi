// Package cast provides API client helpers for talking to the Kimchi/CAST AI
// remote-session backend: key verification, session resolution, and token
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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

func doRequest(ctx context.Context, method, u, apiKey string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Api-Key", apiKey)
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
			Msg:    fmt.Sprintf("Invalid API key - run 'kimchi setup' to authenticate: %s", endpoint),
			Status: 401,
		}
	case 403:
		return &RemoteAuthError{
			Msg:    fmt.Sprintf("Forbidden - your API key does not have permission to use remote workspaces. %s", endpoint),
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

func findWorkspaceIDByURI(ctx context.Context, orgID, sandboxURL, apiKey, endpoint string) (string, error) {
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
		resp, err := doRequest(reqCtx, http.MethodGet, u, apiKey, nil)
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
					Msg:    fmt.Sprintf("Invalid API key - run 'kimchi setup' to authenticate: %s", endpoint),
					Status: 401,
				}
			case 403:
				return nil, "", &RemoteAuthError{
					Msg:    fmt.Sprintf("Forbidden - your API key does not have permission to list workspaces. %s", endpoint),
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

func fetchWorkspaceByID(ctx context.Context, orgID, workspaceID, apiKey, endpoint string) (string, error) {
	u := fmt.Sprintf("%s/ai-optimizer/v1beta/organizations/%s/workspaces/%s",
		endpoint, url.PathEscape(orgID), url.PathEscape(workspaceID))
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodGet, u, apiKey, nil)
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

// ─── Config / API key ────────────────────────────────────────────────────────

const DefaultEndpoint = "https://app.kimchi.dev/api"

// ReadAPIKey returns the Kimchi API key from the environment.
func ReadAPIKey() (string, error) {
	if k := os.Getenv("KIMCHI_API_KEY"); k != "" {
		return k, nil
	}
	return "", errors.New("KIMCHI_API_KEY environment variable is not set")
}

// ResolveEndpoint returns the API endpoint, falling back to DefaultEndpoint.
func ResolveEndpoint() string {
	if e := os.Getenv("KIMCHI_REMOTE_ENDPOINT"); e != "" {
		return e
	}
	return DefaultEndpoint
}

// ─── Public API ───────────────────────────────────────────────────────────────

// VerifyAPIKey validates the given API key against the endpoint and returns
// the organisation ID associated with it.
func VerifyAPIKey(ctx context.Context, apiKey, endpoint string) (string, error) {
	u := endpoint + "/ai-optimizer/v1beta/workspace-tokens:verifyKey"
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodPost, u, apiKey, nil)
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
func ResolveWorkspaceID(ctx context.Context, orgID, workspaceIDOrSandboxURL, apiKey, endpoint string) (workspaceID, sandboxURL string, err error) {
	if strings.Contains(workspaceIDOrSandboxURL, ".") {
		id, err := findWorkspaceIDByURI(ctx, orgID, workspaceIDOrSandboxURL, apiKey, endpoint)
		return id, workspaceIDOrSandboxURL, err
	}
	uri, err := fetchWorkspaceByID(ctx, orgID, workspaceIDOrSandboxURL, apiKey, endpoint)
	return workspaceIDOrSandboxURL, uri, err
}

// ExchangeWorkspaceToken exchanges a workspace ID for a short-lived bearer token.
func ExchangeWorkspaceToken(ctx context.Context, apiKey, workspaceID, endpoint string) (string, error) {
	u := endpoint + "/ai-optimizer/v1beta/workspace-tokens:exchange"
	bodyBytes, _ := json.Marshal(map[string]string{"workspaceId": workspaceID})
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	resp, err := doRequest(reqCtx, http.MethodPost, u, apiKey, bytes.NewReader(bodyBytes))
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
