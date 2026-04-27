package tools

const (
	providerName     = "kimchi"
	APIKeyEnv        = "KIMCHI_API_KEY"
	baseURL          = "https://llm.kimchi.dev/openai/v1"
	anthropicBaseURL = "https://llm.kimchi.dev/anthropic"
)

// AnthropicBaseURL returns the Kimchi Anthropic API endpoint URL.
func AnthropicBaseURL() string {
	return anthropicBaseURL
}

// BaseURL returns the Kimchi OpenAI-compatible API endpoint URL.
func BaseURL() string {
	return baseURL
}
