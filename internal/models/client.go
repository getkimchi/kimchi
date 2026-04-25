package models

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const modelsEndpoint = "https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true"

type apiResponse struct {
	Models []apiModelEntry `json:"models"`
}

type apiModelEntry struct {
	Slug            string      `json:"slug"`
	DisplayName     string      `json:"display_name"`
	Description     string      `json:"description,omitempty"`
	ToolCall        bool        `json:"tool_call,omitempty"`
	Reasoning       bool        `json:"reasoning,omitempty"`
	SupportsImages  bool        `json:"supports_images,omitempty"`
	InputModalities []string    `json:"input_modalities,omitempty"`
	Limits          apiLimits   `json:"limits"`
	Pricing         *apiPricing `json:"pricing,omitempty"`
}

type apiLimits struct {
	ContextWindow   int `json:"context_window"`
	MaxOutputTokens int `json:"max_output_tokens"`
}

type apiPricing struct {
	InputPer1M  float64 `json:"input_per_1m"`
	OutputPer1M float64 `json:"output_per_1m"`
}

// Client fetches model metadata from the Kimchi API.
type Client struct {
	http     *http.Client
	endpoint string
}

// NewClient creates a Client. Pass nil for the default http.Client.
func NewClient(client *http.Client) *Client {
	if client == nil {
		client = &http.Client{
			Timeout: 10 * time.Second,
		}
	}
	return &Client{http: client, endpoint: modelsEndpoint}
}

func (c *Client) FetchModels(ctx context.Context, apiKey string) ([]Model, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", apiKey))
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var apiResp apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	models := make([]Model, 0, len(apiResp.Models))
	for _, e := range apiResp.Models {
		displayName := e.DisplayName
		if displayName == "" {
			displayName = e.Slug
		}
		m := Model{
			Slug:            e.Slug,
			DisplayName:     displayName,
			Description:     e.Description,
			ToolCall:        e.ToolCall,
			Reasoning:       e.Reasoning,
			SupportsImages:  e.SupportsImages,
			InputModalities: e.InputModalities,
			Limits: Limits{
				ContextWindow:   e.Limits.ContextWindow,
				MaxOutputTokens: e.Limits.MaxOutputTokens,
			},
		}
		if e.Pricing != nil {
			m.Pricing = Pricing{
				InputPer1M:  e.Pricing.InputPer1M,
				OutputPer1M: e.Pricing.OutputPer1M,
			}
		}
		models = append(models, m)
	}

	return models, nil
}
