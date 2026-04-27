package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/tools"
)

func TestEnv_GeneratesConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	env, err := Env("test-key", reg)
	require.NoError(t, err)

	managedConfigPath := filepath.Join(tmpDir, ".config", "kimchi", "opencode", "opencode.json")
	data, err := os.ReadFile(managedConfigPath)
	require.NoError(t, err)

	var cfg map[string]any
	require.NoError(t, json.Unmarshal(data, &cfg))

	assert.Equal(t, "https://opencode.ai/config.json", cfg["$schema"])

	providers, ok := cfg["provider"].(map[string]any)
	require.True(t, ok, "provider key should be a map")

	kimchiProvider, ok := providers[tools.ProviderName()].(map[string]any)
	require.True(t, ok, "kimchi provider should be present")

	assert.Equal(t, "Kimchi", kimchiProvider["name"])
	assert.Equal(t, "@ai-sdk/openai-compatible", kimchiProvider["npm"])

	options, ok := kimchiProvider["options"].(map[string]any)
	require.True(t, ok, "options should be a map")
	assert.NotEmpty(t, options["baseURL"])
	assert.Equal(t, "test-key", options["apiKey"])
	assert.Equal(t, true, options["litellmProxy"])

	providerModels, ok := kimchiProvider["models"].(map[string]any)
	require.True(t, ok, "models should be a map")
	assert.Contains(t, providerModels, reg.Main().Slug)
	assert.Contains(t, providerModels, reg.Coding().Slug)
	assert.Contains(t, providerModels, reg.Sub().Slug)

	_ = env
}

func TestEnv_ReturnsXDGConfigHome(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	env, err := Env("test-key", reg)
	require.NoError(t, err)

	expectedXDG := filepath.Join(tmpDir, ".config", "kimchi")
	assert.Equal(t, expectedXDG, env["XDG_CONFIG_HOME"])
}

func TestEnv_MergesExistingConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	existingConfigDir := filepath.Join(tmpDir, ".config", "opencode")
	require.NoError(t, os.MkdirAll(existingConfigDir, 0755))

	existingConfig := map[string]any{
		"theme": "dark",
		"keybindings": map[string]any{
			"submit": "ctrl+enter",
		},
	}
	data, err := json.MarshalIndent(existingConfig, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(existingConfigDir, "opencode.json"), data, 0644))

	reg := models.New()
	_, err = Env("test-key", reg)
	require.NoError(t, err)

	managedConfigPath := filepath.Join(tmpDir, ".config", "kimchi", "opencode", "opencode.json")
	rawData, err := os.ReadFile(managedConfigPath)
	require.NoError(t, err)

	var mergedCfg map[string]any
	require.NoError(t, json.Unmarshal(rawData, &mergedCfg))

	assert.Equal(t, "dark", mergedCfg["theme"], "existing theme setting should be preserved")

	keybindings, ok := mergedCfg["keybindings"].(map[string]any)
	require.True(t, ok, "keybindings should be preserved")
	assert.Equal(t, "ctrl+enter", keybindings["submit"])

	providers, ok := mergedCfg["provider"].(map[string]any)
	require.True(t, ok, "kimchi provider should be injected")
	assert.Contains(t, providers, tools.ProviderName())
}

func TestEnv_WritesCompactionConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	managedConfigPath := filepath.Join(tmpDir, ".config", "kimchi", "opencode", "opencode.json")
	data, err := os.ReadFile(managedConfigPath)
	require.NoError(t, err)

	var cfg map[string]any
	require.NoError(t, json.Unmarshal(data, &cfg))

	compaction, ok := cfg["compaction"].(map[string]any)
	require.True(t, ok, "compaction key should be present")
	assert.Equal(t, true, compaction["auto"])
}
