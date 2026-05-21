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
			Msg:    fmt.Sprintf("Forbidden - your API key does not have permission to use remote sessions. %s", endpoint),
			Status: 403,
		}
	case 404:
		return &RemoteAuthError{
			Msg:    fmt.Sprintf("Session not found or endpoint not available. %s", endpoint),
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

// ─── Session helpers ──────────────────────────────────────────────────────────

type sessionItem struct {
	ID  string `json:"id"`
	URI string `json:"uri"`
}

type listSessionsPage struct {
	Items          []sessionItem `json:"items"`
	NextPageCursor string        `json:"nextPageCursor"`
}

func findSessionIDByURI(ctx context.Context, orgID, sandboxURL, apiKey, endpoint string) (string, error) {
	// fetchPage fetches one page of sessions and returns the items and next cursor.
	// Returns (nil, "", err) on failure.
	fetchPage := func(cursor string) ([]sessionItem, string, error) {
		qs := ""
		if cursor != "" {
			qs = "?page.cursor=" + url.QueryEscape(cursor)
		}
		u := fmt.Sprintf("%s/ai-optimizer/v1beta/organizations/%s/sessions%s",
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
					Msg:    fmt.Sprintf("Forbidden - your API key does not have permission to list sessions. %s", endpoint),
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
		var page listSessionsPage
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
		Msg:    fmt.Sprintf("No session found with URI '%s'.", sandboxURL),
		Status: 404,
	}
}

func fetchSessionByID(ctx context.Context, orgID, sessionID, apiKey, endpoint string) (string, error) {
	u := fmt.Sprintf("%s/ai-optimizer/v1beta/organizations/%s/sessions/%s",
		endpoint, url.PathEscape(orgID), url.PathEscape(sessionID))
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
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Missing uri in session response from %s", u)}
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
	u := endpoint + "/ai-optimizer/v1beta/api-keys:verify"
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
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Unexpected non-JSON response from %s", endpoint)}
	}
	if data.OrganizationID == "" {
		return "", &RemoteNetworkError{Msg: fmt.Sprintf("Missing organizationId in verify response from %s", endpoint)}
	}
	return data.OrganizationID, nil
}

// ResolveSessionID returns the session ID and sandbox URI for the given arg.
// If arg contains a '.', it is treated as a sandbox URL and the session list
// is searched to find the matching ID. Otherwise arg is treated directly as a
// session ID and the session is fetched by ID to obtain its URI.
func ResolveSessionID(ctx context.Context, orgID, sessionIDOrSandboxURL, apiKey, endpoint string) (sessionID, sandboxURL string, err error) {
	if strings.Contains(sessionIDOrSandboxURL, ".") {
		id, err := findSessionIDByURI(ctx, orgID, sessionIDOrSandboxURL, apiKey, endpoint)
		return id, sessionIDOrSandboxURL, err
	}
	uri, err := fetchSessionByID(ctx, orgID, sessionIDOrSandboxURL, apiKey, endpoint)
	return sessionIDOrSandboxURL, uri, err
}

// ExchangeSessionToken exchanges a session ID for a short-lived bearer token.
func ExchangeSessionToken(ctx context.Context, apiKey, sessionID, endpoint string) (string, error) {
	u := endpoint + "/ai-optimizer/v1beta/session-tokens:exchange"
	bodyBytes, _ := json.Marshal(map[string]string{"sessionId": sessionID})
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
