package tools

import (
	"fmt"
	"os/exec"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func init() {
	register(Tool{
		ID:          ToolGSD2,
		Name:        "GSD2",
		Description: "Autonomous coding agent (Get Shit Done v2)",
		ConfigPath:  "~/.gsd/preferences.md",
		BinaryName:  "gsd",
		IsInstalled: detectGSD2,
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeGSD2(scope, apiKey, reg)
		},
	})
}

func detectGSD2() bool {
	_, err := exec.LookPath("gsd")
	if err == nil {
		return true
	}
	_, err = exec.LookPath("gsd-cli")
	return err == nil
}

func writeGSD2(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	modelsPath, err := config.ScopePaths(scope, "~/.gsd/agent/models.json")
	if err != nil {
		return fmt.Errorf("get models config path: %w", err)
	}
	main := reg.Main()
	coding := reg.Coding()
	sub := reg.Sub()

	modelsContent := map[string]any{
		"providers": map[string]any{
			"kimchi": map[string]any{
				"name":         "Kimchi",
				"baseUrl":      baseURL,
				"apiKey":       apiKey,
				"api":          "openai-completions",
				"defaultModel": main.Slug,
				"models": []map[string]any{
					{
						"id":            main.Slug,
						"name":          main.DisplayName,
						"contextWindow": main.Limits.ContextWindow,
						"maxTokens":     main.Limits.MaxOutputTokens,
						"reasoning":     main.Reasoning,
						"input":         []string{"text", "image"},
						"cost": map[string]any{
							"input":      0,
							"output":     0,
							"cacheRead":  0,
							"cacheWrite": 0,
						},
					},
					{
						"id":            coding.Slug,
						"name":          coding.DisplayName,
						"contextWindow": coding.Limits.ContextWindow,
						"maxTokens":     coding.Limits.MaxOutputTokens,
						"reasoning":     coding.Reasoning,
						"input":         []string{"text"},
						"cost": map[string]any{
							"input":      0,
							"output":     0,
							"cacheRead":  0,
							"cacheWrite": 0,
						},
					},
					{
						"id":            sub.Slug,
						"name":          sub.DisplayName,
						"contextWindow": sub.Limits.ContextWindow,
						"maxTokens":     sub.Limits.MaxOutputTokens,
						"reasoning":     sub.Reasoning,
						"input":         []string{"text"},
						"cost": map[string]any{
							"input":      0,
							"output":     0,
							"cacheRead":  0,
							"cacheWrite": 0,
						},
					},
				},
			},
		},
	}

	if err := config.WriteJSON(modelsPath, modelsContent); err != nil {
		return fmt.Errorf("write models.json: %w", err)
	}

	prefsPath, err := config.ScopePaths(scope, "~/.gsd/preferences.md")
	if err != nil {
		return fmt.Errorf("get preferences config path: %w", err)
	}
	prefsContent := fmt.Sprintf(`---
version: 1
models:
  research: kimchi/%s
  planning: kimchi/%s
  discuss: kimchi/%s
  execution: kimchi/%s
  execution_simple: kimchi/%s
  completion: kimchi/%s
  validation: kimchi/%s
  subagent: kimchi/%s
auto_supervisor:
  model: kimchi/%s
dynamic_routing:
  enabled: false
  tier_models:
    light: kimchi/%s
    standard: kimchi/%s
    heavy:
      - kimchi/%s
      - kimchi/%s
  budget_pressure: false
token_profile: balanced
skill_discovery: suggest
git:
  isolation: worktree
  merge_strategy: squash
---
`, main.Slug, main.Slug, coding.Slug, coding.Slug)

	if err := config.WriteFile(prefsPath, []byte(prefsContent)); err != nil {
		return fmt.Errorf("write preferences.md: %w", err)
	}

	return nil
}
