package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/castai/kimchi/tools/proxy-helper/pkg/cast"
	"github.com/coder/websocket"
)

// fakeBackend stands in for the Kimchi API + the sandbox WS endpoint.
// Both speak plain HTTP over a single httptest.Server; the test rewrites
// buildWSURL so the client connects to /ssh on the same server instead of
// the production wss://<sandbox>/ssh URL.
type fakeBackend struct {
	t            *testing.T
	apiKey       string
	workspaceURI string
	workspaceID  string
	orgID        string
	sessToken    string

	// echo controls what /ssh does with incoming messages. Default: echo back.
	echo func(ctx context.Context, c *websocket.Conn)

	mu           sync.Mutex
	gotAuthOnWS  string
	listRequests int
	// gotOrgHeaders records the SSO organization header of every API call
	// (verifyKey, each list page, exchange) in order.
	gotOrgHeaders []string
}

// authorized checks the bearer and records the SSO organization header.
func (f *fakeBackend) authorized(r *http.Request) bool {
	f.mu.Lock()
	f.gotOrgHeaders = append(f.gotOrgHeaders, r.Header.Get("X-CastAi-Organization-Id"))
	f.mu.Unlock()
	return r.Header.Get("Authorization") == "Bearer "+f.apiKey
}

func newFakeBackend(t *testing.T) *fakeBackend {
	return &fakeBackend{
		t:            t,
		apiKey:       "test-api-key",
		workspaceURI: "sandbox.example.test",
		workspaceID:  "sess-123",
		orgID:        "org-abc",
		sessToken:    "short-lived-token",
	}
}

func (f *fakeBackend) handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/ai-optimizer/v1beta/workspace-tokens:verifyKey", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if !f.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"organizationId": f.orgID})
	})

	mux.HandleFunc("/ai-optimizer/v1beta/organizations/", func(w http.ResponseWriter, r *http.Request) {
		// Only the .../workspaces list lives under here.
		if !strings.HasSuffix(r.URL.Path, "/workspaces") {
			http.NotFound(w, r)
			return
		}
		if !f.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.listRequests++
		page := f.listRequests
		f.mu.Unlock()

		// Two pages: page 1 returns a decoy + cursor, page 2 returns the real match.
		switch r.URL.Query().Get("page.cursor") {
		case "":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]string{
					{"id": "decoy-1", "uri": "other.example.test"},
				},
				"nextPageCursor": "cursor-2",
			})
		case "cursor-2":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]string{
					{"id": f.workspaceID, "uri": f.workspaceURI},
				},
				"nextPageCursor": "",
			})
		default:
			f.t.Errorf("unexpected cursor on list call %d: %q", page, r.URL.Query().Get("page.cursor"))
			http.Error(w, "bad cursor", http.StatusBadRequest)
		}
	})

	mux.HandleFunc("/ai-optimizer/v1beta/workspace-tokens:exchange", func(w http.ResponseWriter, r *http.Request) {
		if !f.authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body.WorkspaceID != f.workspaceID {
			f.t.Errorf("exchange: got workspaceId=%q want %q", body.WorkspaceID, f.workspaceID)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token":      f.sessToken,
			"expireTime": "2099-01-01T00:00:00Z",
		})
	})

	mux.HandleFunc("/ssh", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.gotAuthOnWS = r.Header.Get("Authorization")
		f.mu.Unlock()

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// httptest server is http://… so we'd hit the same-origin check
			// only if a browser-style Origin were sent. Be permissive.
			InsecureSkipVerify: true,
		})
		if err != nil {
			f.t.Errorf("ws accept: %v", err)
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(-1)

		echo := f.echo
		if echo == nil {
			echo = defaultEcho
		}
		echo(r.Context(), c)
	})

	return mux
}

func defaultEcho(ctx context.Context, c *websocket.Conn) {
	// Read one message, reverse it, write it back, then close normally.
	typ, data, err := c.Read(ctx)
	if err != nil {
		return
	}
	out := make([]byte, len(data))
	for i, b := range data {
		out[len(data)-1-i] = b
	}
	if err := c.Write(ctx, typ, out); err != nil {
		return
	}
	_ = c.Close(websocket.StatusNormalClosure, "")
}

func TestProxyConnect_HappyPath(t *testing.T) {
	fb := newFakeBackend(t)
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	// Point the WS dial at our httptest server.
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	origBuildWSURL := buildWSURL
	buildWSURL = func(sandboxURL string, _ int) string {
		if sandboxURL != fb.workspaceURI {
			t.Errorf("buildWSURL: got %q want %q", sandboxURL, fb.workspaceURI)
		}
		return "ws://" + u.Host + "/ssh"
	}
	defer func() { buildWSURL = origBuildWSURL }()

	// Use a pipe so stdin doesn't EOF and race with the server's normal
	// close. We write "hello" once and leave the writer open until the call
	// returns; the server closes after echoing.
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	go func() { _, _ = stdinW.Write([]byte("hello")) }()
	var stdout bytes.Buffer

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := proxyConnectIO(ctx, fb.workspaceURI, cast.Credentials{Token: fb.apiKey}, srv.URL, 443, stdinR, &stdout); err != nil {
		t.Fatalf("proxyConnectIO: %v", err)
	}

	if got, want := stdout.String(), "olleh"; got != want {
		t.Errorf("stdout: got %q want %q", got, want)
	}

	fb.mu.Lock()
	defer fb.mu.Unlock()
	if want := "Bearer " + fb.sessToken; fb.gotAuthOnWS != want {
		t.Errorf("WS Authorization: got %q want %q", fb.gotAuthOnWS, want)
	}
	if fb.listRequests != 2 {
		t.Errorf("expected pagination to make 2 list calls, got %d", fb.listRequests)
	}
}

// dialFakeWS points the WS dial at the httptest server for the test's lifetime.
func dialFakeWS(t *testing.T, srv *httptest.Server) {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	orig := buildWSURL
	buildWSURL = func(_ string, _ int) string { return "ws://" + u.Host + "/ssh" }
	t.Cleanup(func() { buildWSURL = orig })
}

func runEchoSession(t *testing.T, fb *fakeBackend, srv *httptest.Server, creds cast.Credentials) {
	t.Helper()
	dialFakeWS(t, srv)
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	go func() { _, _ = stdinW.Write([]byte("hello")) }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := proxyConnectIO(ctx, fb.workspaceURI, creds, srv.URL, 443, stdinR, io.Discard); err != nil {
		t.Fatalf("proxyConnectIO: %v", err)
	}
}

func TestProxyConnect_SendsSSOOrganizationOnEveryAPICall(t *testing.T) {
	fb := newFakeBackend(t)
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	runEchoSession(t, fb, srv, cast.Credentials{Token: fb.apiKey, OrganizationID: "org-picked"})

	fb.mu.Lock()
	defer fb.mu.Unlock()
	// verifyKey + 2 list pages + exchange.
	want := []string{"org-picked", "org-picked", "org-picked", "org-picked"}
	if strings.Join(fb.gotOrgHeaders, ",") != strings.Join(want, ",") {
		t.Errorf("org headers: got %q want %q", fb.gotOrgHeaders, want)
	}
}

func TestProxyConnect_OmitsOrganizationHeaderForAPIKeys(t *testing.T) {
	fb := newFakeBackend(t)
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	runEchoSession(t, fb, srv, cast.Credentials{Token: fb.apiKey})

	fb.mu.Lock()
	defer fb.mu.Unlock()
	if len(fb.gotOrgHeaders) != 4 {
		t.Fatalf("expected 4 API calls, got %d", len(fb.gotOrgHeaders))
	}
	for i, h := range fb.gotOrgHeaders {
		if h != "" {
			t.Errorf("call %d: unexpected org header %q", i, h)
		}
	}
}

func TestProxyConnect_BadAPIKey(t *testing.T) {
	fb := newFakeBackend(t)
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := proxyConnectIO(ctx, fb.workspaceURI, cast.Credentials{Token: "wrong-key"}, srv.URL, 443, strings.NewReader(""), io.Discard)
	if err == nil {
		t.Fatal("expected error for bad API key")
	}
	var authErr *cast.RemoteAuthError
	if !errors.As(err, &authErr) || authErr.Status != 401 {
		t.Errorf("got %T %v; want *cast.RemoteAuthError status=401", err, err)
	}
	// SSO tokens fail here too, so the message must not blame an API key only.
	if !strings.Contains(err.Error(), "Invalid credentials (API key or SSO token)") {
		t.Errorf("401 message: got %q", err.Error())
	}
}

func TestProxyConnect_WorkspaceNotFound(t *testing.T) {
	fb := newFakeBackend(t)
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := proxyConnectIO(ctx, "nonexistent.example.test", cast.Credentials{Token: fb.apiKey}, srv.URL, 443, strings.NewReader(""), io.Discard)
	if err == nil {
		t.Fatal("expected error for missing workspace URI")
	}
	var authErr *cast.RemoteAuthError
	if !errors.As(err, &authErr) || authErr.Status != 404 {
		t.Errorf("got %T %v; want *cast.RemoteAuthError status=404", err, err)
	}
}

func TestProxyConnect_ServerCloseExitsCleanly(t *testing.T) {
	fb := newFakeBackend(t)
	fb.echo = func(ctx context.Context, c *websocket.Conn) {
		// Send one message, then close normally without reading anything.
		_ = c.Write(ctx, websocket.MessageBinary, []byte("server-says-bye"))
		_ = c.Close(websocket.StatusNormalClosure, "")
	}
	srv := httptest.NewServer(fb.handler())
	defer srv.Close()

	u, _ := url.Parse(srv.URL)
	origBuildWSURL := buildWSURL
	buildWSURL = func(_ string, _ int) string { return "ws://" + u.Host + "/ssh" }
	defer func() { buildWSURL = origBuildWSURL }()

	// Use a stdin that blocks forever so the read goroutine doesn't race the
	// server close.
	stdin, stdinW := io.Pipe()
	defer stdinW.Close()
	var stdout bytes.Buffer

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- proxyConnectIO(ctx, fb.workspaceURI, cast.Credentials{Token: fb.apiKey}, srv.URL, 443, stdin, &stdout)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("expected nil err on normal server close, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("proxyConnect did not return after server-side normal close")
	}

	if got := stdout.String(); got != "server-says-bye" {
		t.Errorf("stdout: got %q want %q", got, "server-says-bye")
	}
}

func TestReadCredentials(t *testing.T) {
	t.Setenv("KIMCHI_API_KEY", "env-key")
	t.Setenv("KIMCHI_ORGANIZATION_ID", "")
	c, err := cast.ReadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if c != (cast.Credentials{Token: "env-key"}) {
		t.Errorf("got %+v want token only", c)
	}

	t.Setenv("KIMCHI_ORGANIZATION_ID", "org-picked")
	c, err = cast.ReadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if c != (cast.Credentials{Token: "env-key", OrganizationID: "org-picked"}) {
		t.Errorf("got %+v want token and org", c)
	}

	t.Setenv("KIMCHI_API_KEY", "")
	if _, err := cast.ReadCredentials(); err == nil {
		t.Error("expected error when KIMCHI_API_KEY is unset")
	}
}
