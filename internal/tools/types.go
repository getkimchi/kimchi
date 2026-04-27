package tools

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

type ToolID string

const (
	ToolOpenCode   ToolID = "opencode"
	ToolContinue   ToolID = "continue"
	ToolWindsurf   ToolID = "windsurf"
	ToolZed        ToolID = "zed"
	ToolCodex      ToolID = "codex"
	ToolCline      ToolID = "cline"
	ToolGSD2       ToolID = "gsd2"
	ToolOpenClaw   ToolID = "openclaw"
	ToolClaudeCode ToolID = "claudecode"
	ToolCursor     ToolID = "cursor"
	ToolGeneric    ToolID = "generic"
)

type Tool struct {
	ID          ToolID
	Name        string
	Description string
	ConfigPath  string
	BinaryName  string
	InstallURL  string
	InstallArgs []string
	IsInstalled func() bool
	Write       func(scope config.ConfigScope, apiKey string, reg *models.Registry) error
}

func (t Tool) DetectInstalled() bool {
	if t.IsInstalled == nil {
		return false
	}
	return t.IsInstalled()
}

// CanInstall reports whether this tool has an install script URL.
func (t Tool) CanInstall() bool {
	return t.InstallURL != ""
}

// Install downloads and runs the tool's install script.
// Returns an error if the tool has no InstallURL or the platform is unsupported.
func (t Tool) Install() error {
	if t.InstallURL == "" {
		return fmt.Errorf("no installer available for %s", t.Name)
	}

	switch runtime.GOOS {
	case "darwin", "linux":
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	tmpDir, err := os.MkdirTemp("", "kimchi-install-*")
	if err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	scriptPath := filepath.Join(tmpDir, "install.sh")

	resp, err := http.Get(t.InstallURL) //nolint:gosec,noctx // URL is from tool registration.
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", t.InstallURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download %s: HTTP %d", t.InstallURL, resp.StatusCode)
	}

	f, err := os.Create(scriptPath)
	if err != nil {
		return fmt.Errorf("failed to create install script: %w", err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		return fmt.Errorf("failed to write install script: %w", err)
	}
	_ = f.Close()

	if err := os.Chmod(scriptPath, 0o700); err != nil {
		return fmt.Errorf("failed to make install script executable: %w", err)
	}

	var outputBuf bytes.Buffer
	args := append([]string{scriptPath}, t.InstallArgs...)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdout = &outputBuf
	cmd.Stderr = &outputBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s install failed: %s (%w)", t.Name, strings.TrimSpace(outputBuf.String()), err)
	}

	return nil
}
