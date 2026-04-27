package codex

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/tools"
)

func TestEnv_ReturnsCODEXHOME(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	env, err := Env("test-key", reg)
	require.NoError(t, err)

	expectedHome := filepath.Join(tmpDir, ".config", "kimchi", "codex")
	assert.Equal(t, expectedHome, env["CODEX_HOME"])
	assert.Equal(t, "test-key", env[tools.APIKeyEnv])
}

func TestEnv_WritesKimchiProvider(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	configPath := filepath.Join(tmpDir, ".config", "kimchi", "codex", "config.toml")
	cfg, err := config.ReadTOML(configPath)
	require.NoError(t, err)

	assert.Equal(t, reg.Coding().Slug, cfg["model"])
	assert.Equal(t, tools.ProviderName(), cfg["model_provider"])

	providers, ok := cfg["model_providers"].(map[string]any)
	require.True(t, ok)
	_, ok = providers["kimchi"]
	assert.True(t, ok, "kimchi provider should be present")
}

func TestEnv_CopiesUserConfig(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	userDir := filepath.Join(tmpDir, ".codex")
	require.NoError(t, os.MkdirAll(userDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(userDir, "config.toml"), []byte(`
[sandbox]
mode = "allow"
`), 0644))

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	configPath := filepath.Join(tmpDir, ".config", "kimchi", "codex", "config.toml")
	cfg, err := config.ReadTOML(configPath)
	require.NoError(t, err)

	sandbox, ok := cfg["sandbox"].(map[string]any)
	require.True(t, ok, "user sandbox settings should be preserved")
	assert.Equal(t, "allow", sandbox["mode"])
}

func TestEnv_CopiesUserAgents(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	agentsDir := filepath.Join(tmpDir, ".codex", "agents")
	require.NoError(t, os.MkdirAll(agentsDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(agentsDir, "custom.md"), []byte("my agent"), 0644))

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	data, err := os.ReadFile(filepath.Join(tmpDir, ".config", "kimchi", "codex", "agents", "custom.md"))
	require.NoError(t, err)
	assert.Equal(t, "my agent", string(data))
}

func TestEnv_WritesDefaultAgentsMD(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	agentsPath := filepath.Join(tmpDir, ".config", "kimchi", "codex", "AGENTS.md")
	data, err := os.ReadFile(agentsPath)
	require.NoError(t, err)
	assert.Contains(t, string(data), "Kimchi")
}

func TestEnv_PreservesUserAgentsMD(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)

	userDir := filepath.Join(tmpDir, ".codex")
	require.NoError(t, os.MkdirAll(userDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(userDir, "AGENTS.md"), []byte("custom instructions"), 0644))

	reg := models.New()
	_, err := Env("test-key", reg)
	require.NoError(t, err)

	data, err := os.ReadFile(filepath.Join(tmpDir, ".config", "kimchi", "codex", "AGENTS.md"))
	require.NoError(t, err)
	assert.Equal(t, "custom instructions", string(data))
}
