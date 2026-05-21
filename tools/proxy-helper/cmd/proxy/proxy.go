package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"github.com/castai/kimchi/tools/proxy-helper/pkg/cast"
	"github.com/coder/websocket"
	"github.com/spf13/cobra"
)

const httpTimeout = 30 * time.Second

// ─── Errors ───────────────────────────────────────────────────────────────────

// isClosedNetworkError reports whether err is the internal "use of closed
// network connection" error that the net package emits when I/O is attempted
// on an already-closed connection. The error is not exported by the stdlib so
// we must match by message.
func isClosedNetworkError(err error) bool {
	if err == nil {
		return false
	}
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return strings.Contains(netErr.Err.Error(), "use of closed network connection")
	}
	return strings.Contains(err.Error(), "use of closed network connection")
}

// ─── Tunnel orchestration ─────────────────────────────────────────────────────

type tunnelCreds struct {
	wsURL string
	token string
}

// buildWSURL constructs the WebSocket SSH-tunnel URL for a sandbox host.
// Exposed as a var so tests can point it at a local httptest server.
var buildWSURL = func(sandboxURL string, port int) string {
	return "wss://" + sandboxURL + ":" + strconv.Itoa(port) + "/ssh"
}

func resolveTunnelCredentials(ctx context.Context, sessionIDOrSandboxURL, apiKey, endpoint string, port int) (*tunnelCreds, error) {
	orgID, err := cast.VerifyAPIKey(ctx, apiKey, endpoint)
	if err != nil {
		return nil, err
	}
	sessionID, sandboxURL, err := cast.ResolveSessionID(ctx, orgID, sessionIDOrSandboxURL, apiKey, endpoint)
	if err != nil {
		return nil, err
	}
	token, err := cast.ExchangeSessionToken(ctx, apiKey, sessionID, endpoint)
	if err != nil {
		return nil, err
	}
	return &tunnelCreds{
		wsURL: buildWSURL(sandboxURL, port),
		token: token,
	}, nil
}

// ─── WebSocket binary bridge ──────────────────────────────────────────────────

func runBinaryBridgeIO(ctx context.Context, wsURL, token string, stdin io.Reader, stdout io.Writer) error {
	dialCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()

	headers := http.Header{}
	if token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
	ws, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		return fmt.Errorf("websocket dial %s: %w", wsURL, err)
	}
	// Lift the default 32 MiB per-message read limit — SSH traffic can
	// exceed it on large transfers and we're just splicing bytes.
	ws.SetReadLimit(-1)
	defer ws.CloseNow()

	bridgeCtx, cancelBridge := context.WithCancel(ctx)
	defer cancelBridge()

	errCh := make(chan error, 2)

	// stdin → WebSocket (binary frames)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := stdin.Read(buf)
			if n > 0 {
				if werr := ws.Write(bridgeCtx, websocket.MessageBinary, buf[:n]); werr != nil {
					if isClosedNetworkError(werr) {
						errCh <- nil
						return
					}
					errCh <- werr
					return
				}
			}
			if rerr != nil {
				if errors.Is(rerr, io.EOF) || isClosedNetworkError(rerr) {
					_ = ws.Close(websocket.StatusNormalClosure, "")
					errCh <- nil
					return
				}
				errCh <- rerr
				return
			}
		}
	}()

	// WebSocket → stdout
	go func() {
		for {
				_, data, rerr := ws.Read(bridgeCtx)
			if rerr != nil {
				if isClosedNetworkError(rerr) {
					errCh <- nil
					return
				}
				status := websocket.CloseStatus(rerr)
				if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
					errCh <- nil
					return
				}
				errCh <- rerr
				return
			}
			if len(data) > 0 {
				if _, werr := stdout.Write(data); werr != nil {
					if isClosedNetworkError(werr) {
						errCh <- nil
						return
					}
					errCh <- werr
					return
				}
			}
		}
	}()

	// First direction to finish/fail wins; cancelling bridgeCtx via defer
	// unblocks the other goroutine.
	return <-errCh
}

// ─── Connect helpers ──────────────────────────────────────────────────────────

func proxyConnect(ctx context.Context, arg, apiKey, endpoint string, port int) error {
	return proxyConnectIO(ctx, arg, apiKey, endpoint, port, os.Stdin, os.Stdout)
}

func proxyConnectIO(ctx context.Context, sessionIDOrSandboxURL, apiKey, endpoint string, port int, stdin io.Reader, stdout io.Writer) error {
	creds, err := resolveTunnelCredentials(ctx, sessionIDOrSandboxURL, apiKey, endpoint, port)
	if err != nil {
		return err
	}
	return runBinaryBridgeIO(ctx, creds.wsURL, creds.token, stdin, stdout)
}

// ─── Cobra commands ───────────────────────────────────────────────────────────

func NewSSHProxyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ssh-proxy <sandbox-host>",
		Short: "SSH ProxyCommand bridge to a Kimchi remote sandbox",
		Long: `Acts as an SSH ProxyCommand bridge to a Kimchi remote sandbox.

Requires $KIMCHI_API_KEY to be set.
Override the API endpoint with $KIMCHI_REMOTE_ENDPOINT.

Example ~/.ssh/config entry:

  Host *.remote.kimchi.dev
    ProxyCommand kimchi-ssh-proxy ssh-proxy %h`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			port, err := cmd.Flags().GetInt("port")
			if err != nil {
				return err
			}
			apiKey, err := cast.ReadAPIKey()
			if err != nil {
				return err
			}

			ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer cancel()

			if err := proxyConnect(ctx, args[0], apiKey, cast.ResolveEndpoint(), port); err != nil {
				return fmt.Errorf("ssh-proxy: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().Int("port", 443, "WebSocket port to connect to on the sandbox host")
	return cmd
}
