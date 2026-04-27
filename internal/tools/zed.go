package tools

import (
	"fmt"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func init() {
	register(Tool{
		ID:          ToolZed,
		Name:        "Zed",
		Description: "High-performance editor",
		ConfigPath:  "~/.zed/settings.json",
		BinaryName:  "zed",
		IsInstalled: detectBinary("zed"),
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeZed(scope, apiKey, reg)
		},
	})
}

func writeZed(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	path, err := config.ScopePaths(scope, "~/.zed/settings.json")
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	existing, err := config.ReadJSON(path)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	assistant, _ := existing["assistant"].(map[string]any)
	if assistant == nil {
		assistant = make(map[string]any)
	}

	defaultModel, _ := assistant["default_model"].(map[string]any)
	if defaultModel == nil {
		defaultModel = make(map[string]any)
	}
	defaultModel["provider"] = "openai"
	defaultModel["model"] = reg.Main().Slug
	assistant["default_model"] = defaultModel

	openai, _ := assistant["openai"].(map[string]any)
	if openai == nil {
		openai = make(map[string]any)
	}
	openai["api_key"] = apiKey
	openai["base_url"] = baseURL
	assistant["openai"] = openai

	existing["assistant"] = assistant

	if err := config.WriteJSON(path, existing); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}
