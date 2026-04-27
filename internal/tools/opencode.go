package tools

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
)

const (
	npmRegistryBaseURL    = "https://registry.npmjs.org"
	pluginPackage         = "@kimchi-dev/opencode-kimchi"
	PluginPackage         = pluginPackage
	PluginArrayMinVersion = "1.14.0"
)

var opencodeVersionRegexp = regexp.MustCompile(`opencode\s+v?(\d+\.\d+\.\d+)`)

// GetOpenCodeVersion returns the installed OpenCode version by running `opencode --version`.
// Returns empty string if the version cannot be determined.
func GetOpenCodeVersion() string {
	cmd := exec.Command("opencode", "--version")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	matches := opencodeVersionRegexp.FindStringSubmatch(string(out))
	if len(matches) < 2 {
		return ""
	}
	return matches[1]
}

// IsPluginArraySupported returns true if the given OpenCode version supports
// the array plugin format (>= 1.14.0). Returns false for older versions or
// if version is empty/unparseable.
func IsPluginArraySupported() bool {
	version := GetOpenCodeVersion()
	if version == "" {
		return false
	}
	v, err := semver.NewVersion(version)
	if err != nil {
		return false
	}
	min, _ := semver.NewVersion(PluginArrayMinVersion)
	return v.GreaterThan(min) || v.Equal(min)
}

func init() {
	register(Tool{
		ID:          ToolOpenCode,
		Name:        "OpenCode",
		Description: "Agentic coding CLI",
		ConfigPath:  "~/.config/opencode/opencode.json",
		BinaryName:  "opencode",
		IsInstalled: detectBinary("opencode"),
		Write: func(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
			return writeOpenCode(scope, apiKey, reg)
		},
	})
}

// npmPackageResponse represents the response from npm registry
// We only care about the version field
type npmPackageResponse struct {
	Version string `json:"version"`
}

// getLatestNPMVersion queries npm registry for the latest version of a package
func getLatestNPMVersion(packageName string) (string, error) {
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	url := fmt.Sprintf("%s/%s/latest", npmRegistryBaseURL, packageName)
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("failed to query npm registry: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("npm registry returned status %d", resp.StatusCode)
	}

	var pkg npmPackageResponse
	if err := json.NewDecoder(resp.Body).Decode(&pkg); err != nil {
		return "", fmt.Errorf("failed to parse npm response: %w", err)
	}

	if pkg.Version == "" {
		return "", fmt.Errorf("no version found in npm response")
	}

	return pkg.Version, nil
}

// extractVersionFromPlugin extracts the version from a plugin package name
// Handles formats like "@kimchi-dev/opencode-kimchi", "@kimchi-dev/opencode-kimchi@latest" or "@kimchi-dev/opencode-kimchi@1.2.3"
func extractVersionFromPlugin(pkgName string) string {
	// Match @kimchi-dev/opencode-kimchi@<version>
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(pluginPackage) + `@(.+)$`)
	matches := re.FindStringSubmatch(pkgName)
	if len(matches) > 1 {
		return matches[1]
	}
	return ""
}

func writeOpenCode(scope config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	path, err := config.ScopePaths(scope, "~/.config/opencode/opencode.json")
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	existing, err := config.ReadJSON(path)
	if err != nil {
		return fmt.Errorf("read existing config: %w", err)
	}

	existing["$schema"] = "https://opencode.ai/config.json"

	providers, _ := existing["provider"].(map[string]any)
	if providers == nil {
		providers = make(map[string]any)
	}
	providers[providerName] = OpenCodeProviderConfig(apiKey, reg)
	existing["provider"] = providers

	existing["model"] = providerName + "/" + reg.Main().Slug

	if _, ok := existing["compaction"]; !ok {
		existing["compaction"] = map[string]any{
			"auto": true,
		}
	}

	// Add or update Kimchi plugin while preserving existing plugins
	// Plugin format is an array of arrays: [[npm_package, config], ...]
	telemetryEnabled, _ := config.IsTelemetryEnabled()

	pluginConfig := map[string]any{}
	if telemetryEnabled {
		pluginConfig["telemetry"] = true
		pluginConfig["logsEndpoint"] = "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest"
		pluginConfig["metricsEndpoint"] = "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest"
	}

	// Get existing plugins or create new array
	var plugins []any
	if existingPlugins, ok := existing["plugin"].([]any); ok {
		plugins = existingPlugins
	}

	// Find existing Kimchi plugin version if any
	existingVersion := ""
	var filteredPlugins []any
	for _, p := range plugins {
		if pluginArr, ok := p.([]any); ok && len(pluginArr) > 0 {
			if pkgName, ok := pluginArr[0].(string); ok && strings.HasPrefix(pkgName, pluginPackage) {
				existingVersion = extractVersionFromPlugin(pkgName)
				continue // Skip existing Kimchi plugins
			}
		}
		filteredPlugins = append(filteredPlugins, p)
	}

	// Query npm for latest version
	latestVersion, err := getLatestNPMVersion(pluginPackage)
	if err != nil {
		// Fallback: use existing version if available, otherwise don't update
		if existingVersion != "" {
			latestVersion = existingVersion
		} else {
			// No existing plugin and npm query failed - skip plugin update
			// Keep existing plugins without adding Kimchi plugin
			existing["plugin"] = filteredPlugins
			if err := config.WriteJSON(path, existing); err != nil {
				return fmt.Errorf("write config: %w", err)
			}
			return nil
		}
	}

	// Only update if version changed or no existing plugin
	shouldUpdate := existingVersion == "" || existingVersion != latestVersion

	if shouldUpdate {
		kimchiPlugin := []any{pluginPackage + "@" + latestVersion, pluginConfig}
		plugins = append(filteredPlugins, kimchiPlugin)
	} else {
		// Keep existing plugin configuration
		plugins = append(filteredPlugins, []any{pluginPackage + "@" + existingVersion, pluginConfig})
	}

	if IsPluginArraySupported() {
		existing["plugin"] = plugins
	} else {
		existing["plugin"] = []string{pluginPackage}
	}

	if err := config.WriteJSON(path, existing); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}

// OpenCodeProviderConfig returns the provider configuration map for OpenCode.
func OpenCodeProviderConfig(apiKey string, reg *models.Registry) map[string]any {
	main := reg.Main()
	coding := reg.Coding()
	sub := reg.Sub()
	return map[string]any{
		"npm":  "@ai-sdk/openai-compatible",
		"name": "Kimchi",
		"options": map[string]any{
			"baseURL":      baseURL,
			"litellmProxy": true,
			"apiKey":       apiKey,
		},
		"models": map[string]any{
			main.Slug: map[string]any{
				"name":      main.Slug,
				"tool_call": main.ToolCall,
				"reasoning": main.Reasoning,
				"limit": map[string]any{
					"context": main.Limits.ContextWindow,
					"output":  main.Limits.MaxOutputTokens,
				},
			},
			coding.Slug: map[string]any{
				"name":      coding.Slug,
				"tool_call": coding.ToolCall,
				"reasoning": coding.Reasoning,
				"limit": map[string]any{
					"context": coding.Limits.ContextWindow,
					"output":  coding.Limits.MaxOutputTokens,
				},
			},
			sub.Slug: map[string]any{
				"name":      sub.Slug,
				"tool_call": sub.ToolCall,
				"reasoning": sub.Reasoning,
				"limit": map[string]any{
					"context": sub.Limits.ContextWindow,
					"output":  sub.Limits.MaxOutputTokens,
				},
			},
		},
	}
}

func detectBinary(name string) func() bool {
	return func() bool {
		_, err := exec.LookPath(name)
		return err == nil
	}
}
