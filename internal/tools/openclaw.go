package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Masterminds/semver/v3"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

const openclawConfigPath = "~/.openclaw/openclaw.json"

// openclawVersionRegexp matches "OpenClaw 2026.4.8 (9ece252)" format
var openclawVersionRegexp = regexp.MustCompile(`OpenClaw\s+(\d{4}\.\d+\.\d+)`)

const batchConfigMinVersion = "2026.3.17"

// getOpenClawVersion parses the version from `openclaw --version` output.
// Returns empty string if version cannot be determined.
func getOpenClawVersion() string {
	cmd := exec.Command("openclaw", "--version")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}

	matches := openclawVersionRegexp.FindStringSubmatch(string(out))
	if len(matches) < 2 {
		return ""
	}
	return matches[1]
}

// isBatchJSONSupported checks if the OpenClaw version supports --batch-json flag.
// Returns true if version >= 2026.3.17 or if version cannot be determined (assume latest).
func isBatchJSONSupported(version string) bool {
	if version == "" {
		return true // Assume latest if we can't determine version
	}

	v, err := semver.NewVersion(version)
	if err != nil {
		return true // Assume latest if parsing fails
	}

	min, _ := semver.NewVersion(batchConfigMinVersion)
	return v.GreaterThan(min) || v.Equal(min)
}

func init() {
	register(Tool{
		ID:          ToolOpenClaw,
		Name:        "OpenClaw",
		Description: "AI agent framework",
		ConfigPath:  openclawConfigPath,
		BinaryName:  "openclaw",
		InstallURL:  "https://openclaw.ai/install.sh",
		InstallArgs: []string{"--no-prompt", "--no-onboard"},
		IsInstalled: detectOpenClaw,
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeOpenClaw(scope, apiKey, reg)
		},
	})
}

func detectOpenClaw() bool {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return false
	}

	openclawDir := filepath.Join(homeDir, ".openclaw")

	// Check if ~/.openclaw/ directory exists.
	if _, err := os.Stat(openclawDir); err == nil {
		return true
	}

	// Check if openclaw binary is on PATH.
	if _, err := exec.LookPath("openclaw"); err == nil {
		return true
	}

	return false
}

func writeOpenClaw(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	// Prefer CLI-based configuration when the binary is available,
	// as OpenClaw uses JSON5 which may not round-trip cleanly through
	// Go's encoding/json.
	if _, err := exec.LookPath("openclaw"); err == nil {
		return writeOpenClawViaCLI(apiKey, reg)
	}

	return writeOpenClawDirect(scope, apiKey, reg)
}

// writeOpenClawViaCLISequential sets config values one by one for older OpenClaw versions.
func writeOpenClawViaCLISequential(providerBlock map[string]any, modelsCatalog map[string]any, reg *models.Registry) error {
	// Set models.providers.kimchi
	providerJSON, err := json.Marshal(providerBlock)
	if err != nil {
		return fmt.Errorf("marshal provider block: %w", err)
	}
	cmd := exec.Command("openclaw", "config", "set", "models.providers.kimchi", string(providerJSON))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("openclaw config set models.providers.kimchi: %s: %w", string(out), err)
	}

	// Set agents.defaults.model.primary
	cmd = exec.Command("openclaw", "config", "set", "agents.defaults.model.primary", providerName+"/"+reg.Main().Slug)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("openclaw config set agents.defaults.model.primary: %s: %w", string(out), err)
	}

	// Set agents.defaults.model.fallbacks
	fallbacksJSON, _ := json.Marshal([]string{
		providerName + "/" + reg.Coding().Slug,
		providerName + "/" + reg.Sub().Slug,
	})
	cmd = exec.Command("openclaw", "config", "set", "agents.defaults.model.fallbacks", string(fallbacksJSON))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("openclaw config set agents.defaults.model.fallbacks: %s: %w", string(out), err)
	}

	// Set agents.defaults.models
	modelsJSON, err := json.Marshal(modelsCatalog)
	if err != nil {
		return fmt.Errorf("marshal models catalog: %w", err)
	}
	cmd = exec.Command("openclaw", "config", "set", "agents.defaults.models", string(modelsJSON))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("openclaw config set agents.defaults.models: %s: %w", string(out), err)
	}

	return nil
}

func writeOpenClawViaCLI(apiKey string, reg *models.Registry) error {
	// Build the full provider block as JSON so it passes validation in one shot.
	var modelEntries []map[string]any
	for _, m := range reg.All() {
		modelEntries = append(modelEntries, map[string]any{
			"id":            providerName + "/" + m.Slug,
			"name":          m.DisplayName,
			"reasoning":     m.Reasoning,
			"input":         m.InputModalities,
			"contextWindow": m.Limits.ContextWindow,
			"maxTokens":     m.Limits.MaxOutputTokens,
		})
	}

	providerBlock := map[string]any{
		"baseUrl": baseURL,
		"apiKey":  "${KIMCHI_API_KEY}",
		"api":     "openai-completions",
		"models":  modelEntries,
	}

	// Build the models catalog as a single JSON blob to avoid slash-in-path issues.
	modelsCatalog := make(map[string]any)
	for _, m := range reg.All() {
		modelsCatalog[providerName+"/"+m.Slug] = map[string]any{"alias": m.DisplayName}
	}

	// Check OpenClaw version to determine which approach to use
	version := getOpenClawVersion()
	if isBatchJSONSupported(version) {
		// Use --batch-json to set all config in a single CLI call (~3s vs ~12s sequential).
		batchOps := []map[string]any{
			{"path": "models.providers.kimchi", "value": providerBlock},
			{"path": "agents.defaults.model.primary", "value": providerName + "/" + reg.Main().Slug},
			{"path": "agents.defaults.model.fallbacks", "value": []string{
				providerName + "/" + reg.Coding().Slug,
				providerName + "/" + reg.Sub().Slug,
			}},
			{"path": "agents.defaults.models", "value": modelsCatalog},
		}

		batchJSON, err := json.Marshal(batchOps)
		if err != nil {
			return fmt.Errorf("marshal batch config: %w", err)
		}

		cmd := exec.Command("openclaw", "config", "set", "--batch-json", string(batchJSON))
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("openclaw config set: %s: %w", string(out), err)
		}
	} else {
		// Fall back to sequential calls for older versions
		if err := writeOpenClawViaCLISequential(providerBlock, modelsCatalog, reg); err != nil {
			return err
		}
	}

	// Write API key to ~/.openclaw/.env for daemon use.
	if err := writeOpenClawEnv(apiKey); err != nil {
		return fmt.Errorf("write env file: %w", err)
	}

	if isOpenClawGatewayRunning() {
		// Gateway is already running — restart it so the new config takes effect.
		cmd := exec.Command("openclaw", "gateway", "restart")
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("gateway restart: %s: %w", string(out), err)
		}
	} else {
		// Fresh install — run onboard to set up workspace and install the daemon.
		if err := onboardOpenClaw(); err != nil {
			return fmt.Errorf("onboard: %w", err)
		}
	}

	return nil
}

func isOpenClawGatewayRunning() bool {
	cmd := exec.Command("openclaw", "gateway", "status")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "running")
}

func onboardOpenClaw() error {
	// Use --auth-choice skip because we already configured the kimchi provider
	// via config set. Using custom-api-key would create a duplicate provider
	// with wrong defaults that overwrites our settings.
	args := []string{
		"onboard",
		"--non-interactive",
		"--accept-risk",
		"--auth-choice", "skip",
		"--install-daemon",
		"--skip-channels",
		"--skip-skills",
		"--skip-search",
		"--skip-ui",
	}

	cmd := exec.Command("openclaw", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("openclaw onboard: %s: %w", string(out), err)
	}
	return nil
}

func writeOpenClawDirect(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	path, err := config.ScopePaths(scope, openclawConfigPath)
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	existing, err := config.ReadJSON(path)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	// Build the provider block with all models.
	var modelEntries []any
	for _, m := range reg.All() {
		modelEntries = append(modelEntries, map[string]any{
			"id":            providerName + "/" + m.Slug,
			"name":          m.DisplayName,
			"reasoning":     m.Reasoning,
			"input":         m.InputModalities,
			"contextWindow": m.Limits.ContextWindow,
			"maxTokens":     m.Limits.MaxOutputTokens,
		})
	}

	providerBlock := map[string]any{
		"baseUrl": baseURL,
		"apiKey":  "${KIMCHI_API_KEY}",
		"api":     "openai-completions",
		"models":  modelEntries,
	}

	// Merge into models.providers.
	models, _ := existing["models"].(map[string]any)
	if models == nil {
		models = make(map[string]any)
	}
	providers, _ := models["providers"].(map[string]any)
	if providers == nil {
		providers = make(map[string]any)
	}
	providers[providerName] = providerBlock
	models["providers"] = providers
	existing["models"] = models

	// Set agent defaults.
	agents, _ := existing["agents"].(map[string]any)
	if agents == nil {
		agents = make(map[string]any)
	}
	defaults, _ := agents["defaults"].(map[string]any)
	if defaults == nil {
		defaults = make(map[string]any)
	}
	defaults["model"] = map[string]any{
		"primary":   providerName + "/" + reg.Main().Slug,
		"fallbacks": []any{providerName + "/" + reg.Coding().Slug, providerName + "/" + reg.Sub().Slug},
	}

	// Add models to the allowed models catalog.
	modelsCatalog := make(map[string]any)
	for _, m := range reg.All() {
		modelsCatalog[providerName+"/"+m.Slug] = map[string]any{"alias": m.DisplayName}
	}
	defaults["models"] = modelsCatalog
	agents["defaults"] = defaults
	existing["agents"] = agents

	if err := config.WriteJSON(path, existing); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	// Write API key to ~/.openclaw/.env for daemon use.
	if err := writeOpenClawEnv(apiKey); err != nil {
		return fmt.Errorf("write env file: %w", err)
	}

	return nil
}

func writeOpenClawEnv(apiKey string) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("get home directory: %w", err)
	}

	envPath := filepath.Join(homeDir, ".openclaw", ".env")
	envDir := filepath.Dir(envPath)
	if err := os.MkdirAll(envDir, 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	// Read existing .env content and update or append KIMCHI_API_KEY.
	content, err := os.ReadFile(envPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read env file: %w", err)
	}

	line := fmt.Sprintf("KIMCHI_API_KEY=%s", apiKey)
	lines := splitEnvLines(string(content))
	found := false
	for i, l := range lines {
		if len(l) > 14 && l[:14] == "KIMCHI_API_KEY" {
			lines[i] = line
			found = true
			break
		}
	}
	if !found {
		lines = append(lines, line)
	}

	return config.WriteFile(envPath, []byte(joinEnvLines(lines)))
}

func splitEnvLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := make([]string, 0)
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func joinEnvLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	result := ""
	for i, l := range lines {
		if i > 0 {
			result += "\n"
		}
		result += l
	}
	result += "\n"
	return result
}
