package codex

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/gsd"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/tools"
)

// Env prepares the environment for launching Codex with Kimchi configuration.
// It copies the user's ~/.codex/ to a kimchi-managed directory, merges the
// kimchi provider config, and returns CODEX_HOME pointing to the managed copy
// so the original user directory is never modified.
func Env(apiKey string, reg *models.Registry) (map[string]string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("get home directory: %w", err)
	}

	userCodexDir := filepath.Join(homeDir, ".codex")
	managedCodexDir := filepath.Join(homeDir, ".config", "kimchi", "codex")

	// Ensure the managed directory exists even if the user has no ~/.codex/.
	if err := os.MkdirAll(managedCodexDir, 0755); err != nil {
		return nil, fmt.Errorf("create managed codex dir: %w", err)
	}

	// Copy only config-relevant content from the user's codex directory.
	// We skip runtime artifacts (sqlite DBs, logs, sessions, .tmp, etc.)
	// that can contain read-only files and aren't needed for config.
	codexConfigDirs := []string{"agents", "skills", "get-shit-done", "hooks"}
	for _, dir := range codexConfigDirs {
		src := filepath.Join(userCodexDir, dir)
		if err := gsd.CopyInstallation(src, filepath.Join(managedCodexDir, dir)); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("copy user codex %s: %w", dir, err)
		}
	}

	agentsMDCopied := false
	codexConfigFiles := []string{"AGENTS.md", "AGENTS.override.md"}
	for _, file := range codexConfigFiles {
		src := filepath.Join(userCodexDir, file)
		dst := filepath.Join(managedCodexDir, file)
		if data, err := os.ReadFile(src); err == nil {
			if err := config.WriteFile(dst, data); err != nil {
				return nil, fmt.Errorf("copy user codex %s: %w", file, err)
			}
			if file == "AGENTS.md" {
				agentsMDCopied = true
			}
		}
	}

	// Read the user's config.toml as a base so custom settings (sandbox policies,
	// approval settings, other providers) are preserved during the wrapped run.
	// ReadTOML returns an empty map when the file doesn't exist.
	userConfigPath := filepath.Join(userCodexDir, "config.toml")
	cfg, err := config.ReadTOML(userConfigPath)
	if err != nil {
		return nil, fmt.Errorf("read user codex config.toml: %w", err)
	}

	// Merge kimchi provider into the config map.
	cfg["model"] = reg.Coding().Slug
	cfg["model_provider"] = tools.ProviderName()
	cfg["suppress_unstable_features_warning"] = true

	providers, ok := cfg["model_providers"].(map[string]any)
	if !ok {
		if cfg["model_providers"] != nil {
			return nil, fmt.Errorf("codex config %s is malformed: expected model_providers to be a TOML table", userConfigPath)
		}
		providers = make(map[string]any)
		cfg["model_providers"] = providers
	}
	providers["kimchi"] = tools.CodexProviderBlock()

	// Write model catalog into the managed directory.
	managedCatalogPath := filepath.Join(managedCodexDir, "kimchi-models.json")
	if err := tools.WriteCodexModelCatalog(managedCatalogPath, reg); err != nil {
		return nil, fmt.Errorf("write model catalog: %w", err)
	}

	// Reference the catalog from the managed directory before writing config.
	cfg["model_catalog_json"] = managedCatalogPath

	// Write the merged config once.
	managedConfigPath := filepath.Join(managedCodexDir, "config.toml")
	if err := config.WriteTOML(managedConfigPath, cfg); err != nil {
		return nil, fmt.Errorf("write managed codex config: %w", err)
	}

	// Write AGENTS.md only if it was not copied from the user's directory.
	if !agentsMDCopied {
		agentsPath := filepath.Join(managedCodexDir, "AGENTS.md")
		if err := config.WriteFile(agentsPath, []byte(tools.CodexAgentMD(reg))); err != nil {
			return nil, fmt.Errorf("write AGENTS.md: %w", err)
		}
	}

	return map[string]string{
		tools.APIKeyEnv: apiKey,
		"CODEX_HOME":    managedCodexDir,
	}, nil
}
