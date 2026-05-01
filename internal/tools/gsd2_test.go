package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goccy/go-yaml"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func TestWriteGSD2(t *testing.T) {
	t.Run("writes complete models.json with all 5 models", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		reg := models.New()
		err := writeGSD2(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		// Read and verify models.json structure
		modelsPath := filepath.Join(tmpDir, ".gsd", "agent", "models.json")
		data, err := os.ReadFile(modelsPath)
		require.NoError(t, err)

		// Parse as generic map to access dynamically
		var modelsData map[string]any
		require.NoError(t, json.Unmarshal(data, &modelsData))

		providers := modelsData["providers"].(map[string]any)
		kimchi := providers["kimchi"].(map[string]any)

		// Verify provider metadata
		assert.Equal(t, "Kimchi", kimchi["name"])
		assert.Equal(t, baseURL, kimchi["baseUrl"])
		assert.Equal(t, "test-api-key", kimchi["apiKey"])
		assert.Equal(t, "openai-completions", kimchi["api"])
		assert.Equal(t, reg.Main().Slug, kimchi["defaultModel"])

		// Verify all 5 models are present
		modelList := kimchi["models"].([]any)
		require.Len(t, modelList, 5)

		modelSlugs := make(map[string]map[string]any)
		for _, m := range modelList {
			model := m.(map[string]any)
			modelSlugs[model["id"].(string)] = model
		}

		// Verify each model exists with correct metadata
		require.Contains(t, modelSlugs, "claude-opus-4-6")
		require.Contains(t, modelSlugs, "claude-sonnet-4-6")
		require.Contains(t, modelSlugs, reg.Main().Slug)
		require.Contains(t, modelSlugs, reg.Coding().Slug)
		require.Contains(t, modelSlugs, reg.Sub().Slug)

		// Verify Opus model has correct full metadata
		opus := modelSlugs["claude-opus-4-6"]
		assert.Equal(t, "Claude Opus 4.6", opus["name"])
		assert.Equal(t, float64(1000000), opus["contextWindow"])
		assert.Equal(t, float64(128000), opus["maxTokens"])
		assert.Equal(t, true, opus["reasoning"])
		assert.Equal(t, []any{"text"}, opus["input"])
		opusCost := opus["cost"].(map[string]any)
		assert.Equal(t, float64(5), opusCost["input"])
		assert.Equal(t, float64(25), opusCost["output"])
		assert.Equal(t, float64(0.5), opusCost["cacheRead"])
		assert.Equal(t, float64(6.25), opusCost["cacheWrite"])

		// Verify Sonnet model has correct full metadata
		sonnet := modelSlugs["claude-sonnet-4-6"]
		assert.Equal(t, "Claude Sonnet 4.6", sonnet["name"])
		assert.Equal(t, float64(1000000), sonnet["contextWindow"])
		assert.Equal(t, float64(128000), sonnet["maxTokens"])
		sonnetCost := sonnet["cost"].(map[string]any)
		assert.Equal(t, float64(3), sonnetCost["input"])
		assert.Equal(t, float64(15), sonnetCost["output"])
		assert.Equal(t, float64(0.3), sonnetCost["cacheRead"])
		assert.Equal(t, float64(3.75), sonnetCost["cacheWrite"])

		// Verify registry-sourced models have zero cost
		for _, slug := range []string{reg.Main().Slug, reg.Coding().Slug, reg.Sub().Slug} {
			model := modelSlugs[slug]
			cost := model["cost"].(map[string]any)
			assert.Equal(t, float64(0), cost["input"], "%s input cost", slug)
			assert.Equal(t, float64(0), cost["output"], "%s output cost", slug)
			assert.Equal(t, float64(0), cost["cacheRead"], "%s cacheRead cost", slug)
			assert.Equal(t, float64(0), cost["cacheWrite"], "%s cacheWrite cost", slug)
		}
	})

	t.Run("writes valid YAML preferences.md with all sections", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		reg := models.New()
		err := writeGSD2(config.ScopeGlobal, "test-api-key", reg)
		require.NoError(t, err)

		prefsPath := filepath.Join(tmpDir, ".gsd", "preferences.md")
		data, err := os.ReadFile(prefsPath)
		require.NoError(t, err)

		content := string(data)

		// Verify YAML frontmatter structure
		assert.True(t, strings.HasPrefix(content, "---"), "should start with YAML frontmatter")
		assert.True(t, strings.Count(content, "---") >= 2, "should have closing --- for frontmatter")
		assert.True(t, strings.HasSuffix(strings.TrimSpace(content), "---"), "should end with ---")

		// Parse the YAML to validate structure
		// Extract just the YAML frontmatter
		yamlStart := strings.Index(content, "---")
		yamlEnd := strings.Index(content[yamlStart+3:], "---")
		require.GreaterOrEqual(t, yamlStart, 0, "should have opening ---")
		require.GreaterOrEqual(t, yamlEnd, 0, "should have closing ---")
		yamlContent := content[yamlStart+3 : yamlStart+3+yamlEnd]

		var prefs map[string]any
		err = yaml.Unmarshal([]byte(yamlContent), &prefs)
		require.NoError(t, err, "YAML should be valid")

		// Verify version (YAML parser returns uint64)
		assert.Equal(t, uint64(1), prefs["version"])

		// Verify all model roles with specific values
		modelRoles := prefs["models"].(map[string]any)
		assert.Equal(t, "kimchi/"+reg.Coding().Slug, modelRoles["research"])
		assert.Equal(t, "kimchi/"+OpusModel.Slug, modelRoles["planning"])
		assert.Equal(t, "kimchi/"+reg.Sub().Slug, modelRoles["discuss"])
		assert.Equal(t, "kimchi/"+reg.Main().Slug, modelRoles["execution"])
		assert.Equal(t, "kimchi/"+reg.Sub().Slug, modelRoles["execution_simple"])
		assert.Equal(t, "kimchi/"+reg.Main().Slug, modelRoles["completion"])
		assert.Equal(t, "kimchi/"+OpusModel.Slug, modelRoles["validation"])
		assert.Equal(t, "kimchi/"+reg.Coding().Slug, modelRoles["subagent"])

		// Verify auto_supervisor section
		autoSupervisor := prefs["auto_supervisor"].(map[string]any)
		assert.Equal(t, "kimchi/"+OpusModel.Slug, autoSupervisor["model"])

		// Verify dynamic_routing section
		dynamicRouting := prefs["dynamic_routing"].(map[string]any)
		assert.Equal(t, false, dynamicRouting["enabled"])
		assert.Equal(t, false, dynamicRouting["budget_pressure"])
		tierModels := dynamicRouting["tier_models"].(map[string]any)
		assert.Equal(t, "kimchi/"+reg.Coding().Slug, tierModels["light"])
		assert.Equal(t, "kimchi/"+reg.Sub().Slug, tierModels["standard"])
		assert.Equal(t, []any{"kimchi/" + reg.Main().Slug, "kimchi/" + OpusModel.Slug}, tierModels["heavy"])

		// Verify other settings
		assert.Equal(t, "balanced", prefs["token_profile"])
		assert.Equal(t, "suggest", prefs["skill_discovery"])
		git := prefs["git"].(map[string]any)
		assert.Equal(t, "worktree", git["isolation"])
		assert.Equal(t, "squash", git["merge_strategy"])
	})

	t.Run("returns error when api key is empty", func(t *testing.T) {
		reg := models.New()
		err := writeGSD2(config.ScopeGlobal, "", reg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "API key not configured")
	})

	t.Run("overwrites existing configuration", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Setenv("HOME", tmpDir)

		// Create existing config files
		gsdDir := filepath.Join(tmpDir, ".gsd")
		agentDir := filepath.Join(gsdDir, "agent")
		require.NoError(t, os.MkdirAll(agentDir, 0755))

		existingModels := `{"providers": {"old": {}}}`
		require.NoError(t, os.WriteFile(filepath.Join(agentDir, "models.json"), []byte(existingModels), 0644))

		existingPrefs := "---\nold: config\n---"
		require.NoError(t, os.WriteFile(filepath.Join(gsdDir, "preferences.md"), []byte(existingPrefs), 0644))

		// Run the writer
		reg := models.New()
		err := writeGSD2(config.ScopeGlobal, "new-api-key", reg)
		require.NoError(t, err)

		// Verify models.json was overwritten
		modelsData, err := os.ReadFile(filepath.Join(agentDir, "models.json"))
		require.NoError(t, err)

		var modelsParsed map[string]any
		require.NoError(t, json.Unmarshal(modelsData, &modelsParsed))
		providers := modelsParsed["providers"].(map[string]any)
		_, hasKimchi := providers["kimchi"]
		assert.True(t, hasKimchi, "should have kimchi provider after overwrite")
		_, hasOld := providers["old"]
		assert.False(t, hasOld, "should not have old provider after overwrite")

		// Verify preferences.md was overwritten
		prefsData, err := os.ReadFile(filepath.Join(gsdDir, "preferences.md"))
		require.NoError(t, err)

		var prefs map[string]any
		content := string(prefsData)
		yamlStart := strings.Index(content, "---")
		yamlEnd := strings.Index(content[yamlStart+3:], "---")
		yamlContent := content[yamlStart+3 : yamlStart+3+yamlEnd]
		require.NoError(t, yaml.Unmarshal([]byte(yamlContent), &prefs))

		_, hasOldConfig := prefs["old"]
		assert.False(t, hasOldConfig, "should not have old config after overwrite")
		assert.Equal(t, uint64(1), prefs["version"], "should have correct version after overwrite")
	})
}
