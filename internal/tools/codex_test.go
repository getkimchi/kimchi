package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func TestWriteCodex(t *testing.T) {
	t.Run("sets model and provider at top level", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		cfg, err := config.ReadTOML(filepath.Join(tmpDir, ".codex", "config.toml"))
		require.NoError(t, err)

		assert.Equal(t, reg.Coding().Slug, cfg["model"])
		assert.Equal(t, providerName, cfg["model_provider"])

		providers := cfg["model_providers"].(map[string]any)
		_, ok := providers["kimchi"]
		assert.True(t, ok, "kimchi provider should be added")
	})

	t.Run("preserves existing config sections", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".codex")
		require.NoError(t, os.MkdirAll(configDir, 0755))

		existing := `[history]
persistence = true
max_entries = 100

[scheduler]
check_interval = 30
`
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(existing), 0644))

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		cfg, err := config.ReadTOML(filepath.Join(configDir, "config.toml"))
		require.NoError(t, err)

		history := cfg["history"].(map[string]any)
		assert.Equal(t, int64(100), history["max_entries"])

		scheduler := cfg["scheduler"].(map[string]any)
		assert.Equal(t, int64(30), scheduler["check_interval"])
	})

	t.Run("preserves existing providers", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".codex")
		require.NoError(t, os.MkdirAll(configDir, 0755))

		existing := `[model_providers.other]
name = "Other Provider"
base_url = "https://other.example.com"
env_key = "OTHER_API_KEY"
wire_api = "responses"
`
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(existing), 0644))

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		cfg, err := config.ReadTOML(filepath.Join(configDir, "config.toml"))
		require.NoError(t, err)

		providers := cfg["model_providers"].(map[string]any)
		other := providers["other"].(map[string]any)
		assert.Equal(t, "Other Provider", other["name"])
		assert.Equal(t, "https://other.example.com", other["base_url"])

		_, ok := providers["kimchi"]
		assert.True(t, ok, "kimchi provider should be added alongside existing providers")
	})

	t.Run("writes model catalog with correct metadata", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		catalogPath := filepath.Join(tmpDir, ".codex", "kimchi-models.json")
		data, err := os.ReadFile(catalogPath)
		require.NoError(t, err)

		var catalog codexCatalog
		require.NoError(t, json.Unmarshal(data, &catalog))
		require.Len(t, catalog.Models, len(reg.All()))

		bySlug := make(map[string]codexModelEntry)
		for _, m := range catalog.Models {
			bySlug[m.Slug] = m
		}
		assert.Equal(t, reg.Main().Limits.ContextWindow, bySlug[reg.Main().Slug].ContextWindow)
		assert.Equal(t, reg.Coding().Limits.ContextWindow, bySlug[reg.Coding().Slug].ContextWindow)
		assert.Equal(t, reg.Sub().Limits.ContextWindow, bySlug[reg.Sub().Slug].ContextWindow)

		assert.Equal(t, "medium", bySlug[reg.Main().Slug].DefaultReasoningLevel)
		assert.Equal(t, 3, len(bySlug[reg.Main().Slug].SupportedReasoningLevels))
		assert.Equal(t, "medium", bySlug[reg.Coding().Slug].DefaultReasoningLevel)
		assert.Equal(t, 3, len(bySlug[reg.Coding().Slug].SupportedReasoningLevels))

		assert.Equal(t, "medium", bySlug[reg.Sub().Slug].DefaultReasoningLevel)
		assert.Equal(t, 3, len(bySlug[reg.Sub().Slug].SupportedReasoningLevels))

		cfg, err := config.ReadTOML(filepath.Join(tmpDir, ".codex", "config.toml"))
		require.NoError(t, err)
		assert.Equal(t, catalogPath, cfg["model_catalog_json"])
	})

	t.Run("returns error when model_providers is malformed", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".codex")
		require.NoError(t, os.MkdirAll(configDir, 0755))

		malformed := `model_providers = "not a table"
`
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(malformed), 0644))

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.ErrorContains(t, err, "expected \"model_providers\" to be a TOML table")
	})

	t.Run("returns error when config directory is read-only", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		configDir := filepath.Join(tmpDir, ".codex")
		require.NoError(t, os.MkdirAll(configDir, 0755))
		require.NoError(t, os.WriteFile(filepath.Join(configDir, "config.toml"), []byte(""), 0644))

		require.NoError(t, os.Chmod(configDir, 0555))
		t.Cleanup(func() { _ = os.Chmod(configDir, 0755) })

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.ErrorContains(t, err, "permission denied")
	})

	t.Run("does not overwrite existing AGENTS.md", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		agentsDir := filepath.Join(tmpDir, ".codex")
		require.NoError(t, os.MkdirAll(agentsDir, 0755))
		require.NoError(t, os.WriteFile(filepath.Join(agentsDir, "AGENTS.md"), []byte("custom instructions"), 0644))

		reg := models.New()
		err := writeCodex(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		content, err := os.ReadFile(filepath.Join(agentsDir, "AGENTS.md"))
		require.NoError(t, err)
		assert.Equal(t, "custom instructions", string(content))
	})
}
