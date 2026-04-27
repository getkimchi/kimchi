package claudecode

const anthropicBaseURL = "https://llm.kimchi.dev/anthropic"

func envPairs(baseURL, apiKey string) map[string]string {
	return map[string]string{
		"ANTHROPIC_BASE_URL":                     baseURL,
		"ANTHROPIC_API_KEY":                      "",
		"ANTHROPIC_AUTH_TOKEN":                   apiKey,
		"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
	}
}

// Env returns environment variables for launching Claude Code with Kimchi configuration.
// Unlike OpenCode and Codex, Claude Code doesn't need a managed config directory
// because it reads configuration from ~/.claude/settings.json. However, for the
// wrapper launch, we inject the same env vars that would be in settings.json.
func Env(apiKey string) map[string]string {
	return envPairs(anthropicBaseURL, apiKey)
}

// InjectInto sets the Claude Code environment variables into an existing map[string]any.
func InjectInto(env map[string]any, baseURL, apiKey string) {
	// maps.Copy(env, envPairs(baseURL, apiKey))
	for k, v := range envPairs(baseURL, apiKey) {
		env[k] = v
	}
}
