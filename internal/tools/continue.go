package tools

import (
	"fmt"
	"os"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

const continueConfigPath = "~/.continue/config.json"

func init() {
	register(Tool{
		ID:          ToolContinue,
		Name:        "Continue",
		Description: "AI code assistant extension",
		ConfigPath:  continueConfigPath,
		BinaryName:  "continue",
		IsInstalled: detectContinue,
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeContinue(scope, apiKey, reg)
		},
	})
}

func detectContinue() bool {
	globalPath, err := config.ScopePaths(config.ScopeGlobal, continueConfigPath)
	if err != nil {
		return false
	}
	if _, err := os.Stat(globalPath); err == nil {
		return true
	}
	return false
}

func writeContinue(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	path, err := config.ScopePaths(scope, continueConfigPath)
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	existing, err := config.ReadJSON(path)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	main := reg.Main()
	coding := reg.Coding()
	sub := reg.Sub()

	existingModels, _ := existing["models"].([]any)
	hasMainModel := false
	hasCodingModel := false
	hasSubModel := false

	for _, m := range existingModels {
		modelMap, ok := m.(map[string]any)
		if !ok {
			continue
		}
		title, _ := modelMap["title"].(string)
		if title == main.DisplayName {
			hasMainModel = true
		}
		if title == coding.DisplayName {
			hasCodingModel = true
		}
		if title == sub.DisplayName {
			hasSubModel = true
		}
	}

	if !hasMainModel {
		existingModels = append(existingModels, map[string]any{
			"title":         main.DisplayName,
			"provider":      "openai",
			"model":         main.Slug,
			"apiBase":       baseURL,
			"apiKey":        apiKey,
			"contextLength": main.Limits.ContextWindow,
			"completionOptions": map[string]any{
				"maxTokens": main.Limits.MaxOutputTokens,
			},
		})
	}

	if !hasCodingModel {
		existingModels = append(existingModels, map[string]any{
			"title":         coding.DisplayName,
			"provider":      "openai",
			"model":         coding.Slug,
			"apiBase":       baseURL,
			"apiKey":        apiKey,
			"contextLength": coding.Limits.ContextWindow,
			"completionOptions": map[string]any{
				"maxTokens": coding.Limits.MaxOutputTokens,
			},
		})
	}

	if !hasSubModel {
		existingModels = append(existingModels, map[string]any{
			"title":         sub.DisplayName,
			"provider":      "openai",
			"model":         sub.Slug,
			"apiBase":       baseURL,
			"apiKey":        apiKey,
			"contextLength": sub.Limits.ContextWindow,
			"completionOptions": map[string]any{
				"maxTokens": sub.Limits.MaxOutputTokens,
			},
		})
	}

	existing["models"] = existingModels

	if existing["tabAutocompleteModel"] == nil {
		existing["tabAutocompleteModel"] = map[string]any{
			"title":    main.DisplayName,
			"provider": "openai",
			"model":    main.Slug,
			"apiBase":  baseURL,
			"apiKey":   apiKey,
		}
	}

	if existing["embeddingsProvider"] == nil {
		existing["embeddingsProvider"] = map[string]any{
			"provider": "openai",
			"model":    "text-embedding-3-small",
			"apiBase":  baseURL,
			"apiKey":   apiKey,
		}
	}

	if err := config.WriteJSON(path, existing); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}
