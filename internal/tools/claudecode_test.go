package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castai/kimchi/internal/config"
)

func TestWriteClaudeCode(t *testing.T) {
	t.Run("creates config with correct env vars", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		err := writeClaudeCode(config.ScopeGlobal, "test-api-key")
		require.NoError(t, err)

		configPath := filepath.Join(tmpDir, ".claude", "settings.json")
		data, err := os.ReadFile(configPath)
		require.NoError(t, err)

		var cfg map[string]any
		require.NoError(t, json.Unmarshal(data, &cfg))

	env := cfg["env"].(map[string]any)
	assert.Equal(t, anthropicBaseURL, env["ANTHROPIC_BASE_URL"])
	assert.Equal(t, "", env["ANTHROPIC_API_KEY"])
	assert.Equal(t, "test-api-key", env["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, "1", env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"])
	})

	t.Run("preserves existing config sections", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".claude")
		require.NoError(t, os.MkdirAll(configDir, 0755))

		existing := map[string]any{
			"model": "sonnet",
			"theme": "dark",
		}
		data, _ := json.Marshal(existing)
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "settings.json"), data, 0644))

		err := writeClaudeCode(config.ScopeGlobal, "test-api-key")
		require.NoError(t, err)

		configPath := filepath.Join(configDir, "settings.json")
		data, err = os.ReadFile(configPath)
		require.NoError(t, err)

		var cfg map[string]any
		require.NoError(t, json.Unmarshal(data, &cfg))

	assert.Equal(t, "sonnet", cfg["model"])
	assert.Equal(t, "dark", cfg["theme"])

	env := cfg["env"].(map[string]any)
	assert.Equal(t, "", env["ANTHROPIC_API_KEY"])
	assert.Equal(t, "test-api-key", env["ANTHROPIC_AUTH_TOKEN"])
	})

	t.Run("preserves existing env vars", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".claude")
		require.NoError(t, os.MkdirAll(configDir, 0755))

		existing := map[string]any{
			"env": map[string]any{
				"CUSTOM_VAR":        "custom-value",
				"ANTHROPIC_API_KEY": "old-key", // Should be overwritten
			},
		}
		data, _ := json.Marshal(existing)
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "settings.json"), data, 0644))

		err := writeClaudeCode(config.ScopeGlobal, "new-api-key")
		require.NoError(t, err)

		configPath := filepath.Join(configDir, "settings.json")
		data, err = os.ReadFile(configPath)
		require.NoError(t, err)

		var cfg map[string]any
		require.NoError(t, json.Unmarshal(data, &cfg))

	env := cfg["env"].(map[string]any)
	assert.Equal(t, "custom-value", env["CUSTOM_VAR"])
	assert.Equal(t, "", env["ANTHROPIC_API_KEY"])
	assert.Equal(t, "new-api-key", env["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, anthropicBaseURL, env["ANTHROPIC_BASE_URL"])
	})

	t.Run("returns error when config directory is read-only", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		// Make parent directory read-only so MkdirAll fails
		require.NoError(t, os.Chmod(tmpDir, 0555))
		t.Cleanup(func() { _ = os.Chmod(tmpDir, 0755) })

		err := writeClaudeCode(config.ScopeGlobal, "test-api-key")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "create claude config directory")
	})

	t.Run("supports project scope", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		// Create a fake project directory
		projectDir := filepath.Join(tmpDir, "project")
		require.NoError(t, os.MkdirAll(projectDir, 0755))

		// Change to project directory
		originalWd, err := os.Getwd()
		require.NoError(t, err)
		defer func() { _ = os.Chdir(originalWd) }()
		require.NoError(t, os.Chdir(projectDir))

		err = writeClaudeCode(config.ScopeProject, "project-api-key")
		require.NoError(t, err)

		// Should create config in .claude directory within project
		configPath := filepath.Join(projectDir, ".claude", "settings.json")
		data, err := os.ReadFile(configPath)
		require.NoError(t, err)

		var cfg map[string]any
		require.NoError(t, json.Unmarshal(data, &cfg))

	env := cfg["env"].(map[string]any)
	assert.Equal(t, "", env["ANTHROPIC_API_KEY"])
	assert.Equal(t, "project-api-key", env["ANTHROPIC_AUTH_TOKEN"])
	})
}
