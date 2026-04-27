package tools

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

const codexConfigPath = "~/.codex/config.toml"
const codexAgentsPath = "~/.codex/AGENTS.md"
const codexCatalogPath = "~/.codex/kimchi-models.json"
const envKeyInstructions = "Set the " + APIKeyEnv + " environment variable with your Kimchi API key. You can add it to your shell profile (~/.zshrc, ~/.bashrc) or a .env file."

func codexAgentMD(mainSlug, codingSlug string) string {
	return `# Kimchi Configuration

This project uses Kimchi's open-source models:
- ` + mainSlug + ` for reasoning, planning, and image processing (primary model)
- ` + codingSlug + ` for coding/execution (subagent)

Set the ` + APIKeyEnv + ` environment variable with your Kimchi API key.
`
}

func init() {
	register(Tool{
		ID:          ToolCodex,
		Name:        "Codex",
		Description: "OpenAI coding CLI",
		ConfigPath:  codexConfigPath,
		BinaryName:  "codex",
		IsInstalled: detectBinary("codex"),
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeCodex(scope, apiKey, reg)
		},
	})
}

type codexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

type codexTruncationPolicy struct {
	Mode  string `json:"mode"`
	Limit int    `json:"limit"`
}

type codexModelEntry struct {
	// Required fields
	Slug                       string                `json:"slug"`
	DisplayName                string                `json:"display_name"`
	ShellType                  string                `json:"shell_type"`
	Visibility                 string                `json:"visibility"`
	SupportedInAPI             bool                  `json:"supported_in_api"`
	Priority                   int                   `json:"priority"`
	BaseInstructions           string                `json:"base_instructions"`
	SupportsReasoningSummaries bool                  `json:"supports_reasoning_summaries"`
	SupportVerbosity           bool                  `json:"support_verbosity"`
	TruncationPolicy           codexTruncationPolicy `json:"truncation_policy"`
	SupportsParallelToolCalls  bool                  `json:"supports_parallel_tool_calls"`
	ExperimentalSupportedTools []string              `json:"experimental_supported_tools"`
	SupportedReasoningLevels   []codexReasoningLevel `json:"supported_reasoning_levels"`
	// Optional but useful
	Description           string   `json:"description,omitempty"`
	ContextWindow         int      `json:"context_window,omitempty"`
	InputModalities       []string `json:"input_modalities,omitempty"`
	ApplyPatchToolType    string   `json:"apply_patch_tool_type,omitempty"`
	DefaultReasoningLevel string   `json:"default_reasoning_level,omitempty"`
}

type codexCatalog struct {
	Models []codexModelEntry `json:"models"`
}

// WriteCodexModelCatalog writes the model catalog JSON to the given path.
func WriteCodexModelCatalog(path string, reg *models.Registry) error {
	return writeModelCatalog(path, reg)
}

func writeModelCatalog(path string, reg *models.Registry) error {
	var entries []codexModelEntry
	for _, m := range reg.All() {
		entry := codexModelEntry{
			Slug:             m.Slug,
			DisplayName:      m.DisplayName,
			Description:      m.Description,
			ShellType:        "shell_command",
			Visibility:       "list",
			SupportedInAPI:   true,
			BaseInstructions: "",
			TruncationPolicy:           codexTruncationPolicy{Mode: "tokens", Limit: 25_000},
			SupportsParallelToolCalls:  m.ToolCall,
			ExperimentalSupportedTools: []string{},
			ContextWindow:              m.Limits.ContextWindow,
			InputModalities:            m.InputModalities,
			ApplyPatchToolType:         "function",
		}
		if m.Reasoning {
			entry.DefaultReasoningLevel = "medium"
			entry.SupportedReasoningLevels = []codexReasoningLevel{
				{Effort: "low", Description: "Fast responses with lighter reasoning"},
				{Effort: "medium", Description: "Balances speed and reasoning depth"},
				{Effort: "high", Description: "Greater reasoning depth for complex problems"},
			}
		} else {
			entry.DefaultReasoningLevel = "none"
			entry.SupportedReasoningLevels = []codexReasoningLevel{
				{Effort: "none", Description: "No reasoning"},
			}
		}
		entries = append(entries, entry)
	}
	data, err := json.MarshalIndent(codexCatalog{Models: entries}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal catalog: %w", err)
	}
	return config.WriteFile(path, data)
}

func writeCodex(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	configPath, err := config.ScopePaths(scope, codexConfigPath)
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	cfg, err := config.ReadTOML(configPath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	cfg["model"] = reg.Coding().Slug
	cfg["model_provider"] = providerName
	cfg["suppress_unstable_features_warning"] = true

	providers, ok := cfg["model_providers"].(map[string]any)
	if !ok {
		if cfg["model_providers"] != nil {
			return fmt.Errorf("codex config file %s seems malformed, we don't want to destroy your changes: expected \"model_providers\" to be a TOML table, please fix the file and try again", configPath)
		}

		providers = make(map[string]any)
		cfg["model_providers"] = providers
	}

	providers["kimchi"] = CodexProviderBlock()

	catalogPath, err := config.ScopePaths(scope, codexCatalogPath)
	if err != nil {
		return fmt.Errorf("get catalog path: %w", err)
	}
	if err := writeModelCatalog(catalogPath, reg); err != nil {
		return fmt.Errorf("write model catalog: %w", err)
	}
	cfg["model_catalog_json"] = catalogPath

	if err := config.WriteTOML(configPath, cfg); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	instructionsPath, err := config.ScopePaths(scope, codexAgentsPath)
	if err != nil {
		return fmt.Errorf("get AGENTS.md path: %w", err)
	}

	if _, err := os.Stat(instructionsPath); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("stat AGENTS.md: %w", err)
		}
		if err := config.WriteFile(instructionsPath, []byte(codexAgentMD(reg.Main().Slug, reg.Coding().Slug))); err != nil {
			return fmt.Errorf("write AGENTS.md: %w", err)
		}
	}

	return nil
}

// CodexProviderBlock returns the kimchi provider config map for Codex TOML.
// Shared between override mode (writeCodex) and inject mode (provider/codex).
func CodexProviderBlock() map[string]any {
	return map[string]any{
		"name":                 "Kimchi",
		"base_url":             baseURL,
		"env_key":              APIKeyEnv,
		"env_key_instructions": envKeyInstructions,
		"wire_api":             "responses",
	}
}

// ProviderName returns the kimchi provider name used in tool configs.
func ProviderName() string { return providerName }

// CodexAgentMD returns the default AGENTS.md content for Codex.
func CodexAgentMD(reg *models.Registry) string {
	return codexAgentMD(reg.Main().Slug, reg.Coding().Slug)
}
