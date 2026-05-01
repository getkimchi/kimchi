package tools

import (
	"fmt"
	"os/exec"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

// Hard-coded Anthropic models always offered in GSD2 regardless of what the
// dynamic registry returns. These sit outside the standard kimchi tier system
// and have explicit pricing.
var (
	OpusModel = models.Model{
		Slug:            "claude-opus-4-6",
		DisplayName:     "Claude Opus 4.6",
		Reasoning:       true,
		InputModalities: []string{"text"},
		Limits:          models.Limits{ContextWindow: 1_000_000, MaxOutputTokens: 128_000},
		Pricing:         models.Pricing{InputPer1M: 5, OutputPer1M: 25},
	}
	SonnetModel = models.Model{
		Slug:            "claude-sonnet-4-6",
		DisplayName:     "Claude Sonnet 4.6",
		Reasoning:       true,
		InputModalities: []string{"text"},
		Limits:          models.Limits{ContextWindow: 1_000_000, MaxOutputTokens: 128_000},
		Pricing:         models.Pricing{InputPer1M: 3, OutputPer1M: 15},
	}
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

	main := reg.Main()     // kimi-k2.6 (default)
	coding := reg.Coding() // nemotron-3-super-fp4
	sub := reg.Sub()       // minimax-m2.7

	modelsPath, err := config.ScopePaths(scope, "~/.gsd/agent/models.json")
	if err != nil {
		return fmt.Errorf("get models config path: %w", err)
	}

	modelEntry := func(m models.Model, cost map[string]any) map[string]any {
		input := m.InputModalities
		if len(input) == 0 {
			input = []string{"text"}
		}
		return map[string]any{
			"id":            m.Slug,
			"name":          m.DisplayName,
			"contextWindow": m.Limits.ContextWindow,
			"maxTokens":     m.Limits.MaxOutputTokens,
			"reasoning":     m.Reasoning,
			"input":         input,
			"cost":          cost,
		}
	}

	zeroCost := map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}

	modelsContent := map[string]any{
		"providers": map[string]any{
			"kimchi": map[string]any{
				"name":         "Kimchi",
				"baseUrl":      baseURL,
				"apiKey":       apiKey,
				"api":          "openai-completions",
				"defaultModel": main.Slug,
				"models": []map[string]any{
					modelEntry(OpusModel, map[string]any{
						"input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25,
					}),
					modelEntry(SonnetModel, map[string]any{
						"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75,
					}),
					modelEntry(main, zeroCost),
					modelEntry(coding, zeroCost),
					modelEntry(sub, zeroCost),
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
`,
		coding.Slug,    // research
		OpusModel.Slug, // planning
		sub.Slug,       // discuss
		main.Slug,      // execution
		sub.Slug,       // execution_simple
		main.Slug,      // completion
		OpusModel.Slug, // validation
		coding.Slug,    // subagent
		OpusModel.Slug, // auto_supervisor.model
		coding.Slug,    // tier_models.light
		sub.Slug,       // tier_models.standard
		main.Slug,      // tier_models.heavy[0]
		OpusModel.Slug, // tier_models.heavy[1]
	)

	if err := config.WriteFile(prefsPath, []byte(prefsContent)); err != nil {
		return fmt.Errorf("write preferences.md: %w", err)
	}

	return nil
}
