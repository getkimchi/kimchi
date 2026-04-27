package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/provider/claudecode"
)

const claudeCodeConfigPath = "~/.claude/settings.json"

func init() {
	register(Tool{
		ID:          ToolClaudeCode,
		Name:        "Claude Code",
		Description: "Anthropic's Claude Code CLI",
		ConfigPath:  claudeCodeConfigPath,
		BinaryName:  "claude",
		IsInstalled: detectBinary("claude"),
		Write: func(scope config.ConfigScope, apiKey string, _ *models.Registry) error {
			return writeClaudeCode(scope, apiKey)
		},
	})
}

// writeClaudeCode configures Claude Code to use the Kimchi proxy.
// It only configures the base URL and API key - model selection is handled by Claude Code internally.
func writeClaudeCode(scope config.ConfigScope, apiKey string) error {
	configPath, err := config.ScopePaths(scope, claudeCodeConfigPath)
	if err != nil {
		return fmt.Errorf("get claude config path: %w", err)
	}

	// Ensure directory exists
	configDir := filepath.Dir(configPath)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("create claude config directory: %w", err)
	}

	existing, err := config.ReadJSON(configPath)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	// Get or create env block
	env, ok := existing["env"].(map[string]any)
	if !ok {
		env = make(map[string]any)
	}

	claudecode.InjectInto(env, anthropicBaseURL, apiKey)

	existing["env"] = env

	// Write back with proper formatting
	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal claude config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("write claude config: %w", err)
	}

	return nil
}
