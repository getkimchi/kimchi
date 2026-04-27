package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

func init() {
	register(Tool{
		ID:          ToolWindsurf,
		Name:        "Windsurf",
		Description: "AI-powered IDE with Roo Code",
		ConfigPath:  getWindsurfConfigPath(),
		BinaryName:  "windsurf",
		IsInstalled: detectWindsurf,
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeWindsurf(scope, apiKey, reg)
		},
	})
}

func getWindsurfConfigPath() string {
	if runtime.GOOS == "darwin" {
		return "~/Library/Application Support/Windsurf/User/globalStorage/storage.json"
	}
	return "~/.config/windsurf/User/globalStorage/storage.json"
}

func detectWindsurf() bool {
	globalPath, err := config.ScopePaths(config.ScopeGlobal, getWindsurfConfigPath())
	if err == nil {
		appSupportPath := filepath.Dir(filepath.Dir(filepath.Dir(globalPath))) // trim /User/globalStorage/storage.json
		if _, err := os.Stat(appSupportPath); err == nil {
			return true
		}
	}

	if _, err := exec.LookPath("windsurf"); err == nil {
		return true
	}
	return false
}

func writeWindsurf(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	storagePath, err := config.ScopePaths(scope, getWindsurfConfigPath())
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	storageDir := filepath.Dir(storagePath)
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		return fmt.Errorf("create storage directory: %w", err)
	}

	data, err := os.ReadFile(storagePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read storage: %w", err)
	}

	var storage map[string]any
	if len(data) > 0 {
		if err := json.Unmarshal(data, &storage); err != nil {
			storage = make(map[string]any)
		}
	} else {
		storage = make(map[string]any)
	}

	stateKey := "state.roo-cline"
	state, _ := storage[stateKey].(map[string]any)
	if state == nil {
		state = make(map[string]any)
	}

	apiConfigs, _ := state["apiConfigs"].(map[string]any)
	if apiConfigs == nil {
		apiConfigs = make(map[string]any)
	}

	main := reg.Main()
	coding := reg.Coding()
	sub := reg.Sub()

	kimiConfig := map[string]any{
		"apiProvider": "openai-native",
		"apiKey":      apiKey,
		"baseUrl":     baseURL,
		"modelId":     main.Slug,
		"modelInfo": map[string]any{
			"maxTokens":           main.Limits.MaxOutputTokens,
			"contextWindow":       main.Limits.ContextWindow,
			"supportsImages":      main.SupportsImages,
			"supportsPromptCache": false,
		},
	}

	codingConfig := map[string]any{
		"apiProvider": "openai-native",
		"apiKey":      apiKey,
		"baseUrl":     baseURL,
		"modelId":     coding.Slug,
		"modelInfo": map[string]any{
			"maxTokens":           coding.Limits.MaxOutputTokens,
			"contextWindow":       coding.Limits.ContextWindow,
			"supportsImages":      coding.SupportsImages,
			"supportsPromptCache": false,
		},
	}

	subConfig := map[string]any{
		"apiProvider": "openai-native",
		"apiKey":      apiKey,
		"baseUrl":     baseURL,
		"modelId":     sub.Slug,
		"modelInfo": map[string]any{
			"maxTokens":           sub.Limits.MaxOutputTokens,
			"contextWindow":       sub.Limits.ContextWindow,
			"supportsImages":      sub.SupportsImages,
			"supportsPromptCache": false,
		},
	}

	apiConfigs["kimchi-kimi"] = kimiConfig
	apiConfigs["kimchi-coding"] = codingConfig
	apiConfigs["kimchi-sub"] = subConfig
	state["apiConfigs"] = apiConfigs
	state["currentApiConfigName"] = "kimchi-kimi"
	storage[stateKey] = state

	newData, err := json.MarshalIndent(storage, "", "    ")
	if err != nil {
		return fmt.Errorf("marshal storage: %w", err)
	}

	if err := os.WriteFile(storagePath, newData, 0644); err != nil {
		return fmt.Errorf("write storage: %w", err)
	}

	return nil
}
