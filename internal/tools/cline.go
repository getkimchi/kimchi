package tools

import (
	"fmt"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func init() {
	register(Tool{
		ID:          ToolCline,
		Name:        "Cline",
		Description: "Autonomous coding agent",
		ConfigPath:  "~/.cline/data/globalState.json",
		BinaryName:  "cline",
		IsInstalled: detectBinary("cline"),
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeCline(scope, apiKey, reg)
		},
	})
}

func writeCline(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	path, err := config.ScopePaths(scope, "~/.cline/data/globalState.json")
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	existing, err := config.ReadJSON(path)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	existing["ollamaBaseUrl"] = baseURL
	existing["actModeApiProvider"] = "ollama"
	existing["actModeOllamaModelId"] = reg.Coding().Slug
	existing["actModeOllamaBaseUrl"] = baseURL
	existing["planModeApiProvider"] = "ollama"
	existing["planModeOllamaModelId"] = reg.Main().Slug
	existing["planModeOllamaBaseUrl"] = baseURL
	existing["welcomeViewCompleted"] = true

	if err := config.WriteJSON(path, existing); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}
