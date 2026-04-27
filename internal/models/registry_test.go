package models

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewRegistryFromDefaults(t *testing.T) {
	reg := New()

	require.NotEmpty(t, reg.Main().Slug)
	require.NotEmpty(t, reg.Coding().Slug)
	require.NotEmpty(t, reg.Sub().Slug)
	require.NotEmpty(t, reg.All())

	assert.True(t, reg.Main().Reasoning)
	assert.True(t, reg.Main().SupportsImages)
	assert.True(t, reg.Coding().Reasoning)
	assert.NotEqual(t, reg.Main().Slug, reg.Coding().Slug)
}

func TestDefaultTierAssignment(t *testing.T) {
	defaults := DefaultModels()
	reg := New()

	mainSlug := reg.Main().Slug
	codingSlug := reg.Coding().Slug

	kimiFound := false
	nemotronFound := false
	minimaxFound := false
	for _, m := range defaults {
		switch m.Slug {
		case "kimi-k2.5":
			kimiFound = true
		case "nemotron-3-super-fp4":
			nemotronFound = true
		case "minimax-m2.7":
			minimaxFound = true
		}
	}
	require.True(t, kimiFound && nemotronFound && minimaxFound, "defaults missing expected models")

	assert.Equal(t, "kimi-k2.5", mainSlug)
	assert.Equal(t, "nemotron-3-super-fp4", codingSlug)

	// minimax-m2.7 has reasoning=true so it is a coding candidate, not sub.
	// With no non-reasoning models in defaults, sub falls back to the best overall (kimi-k2.5).
	assert.NotEmpty(t, reg.Sub().Slug)
}

func TestLoadFromAPISuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{Models: []apiModelEntry{
			{
				Slug:           "big-model",
				DisplayName:    "Big Model",
				Reasoning:      true,
				SupportsImages: true,
				Pricing:        &apiPricing{InputPer1M: 2.0, OutputPer1M: 8.0},
			},
			{
				Slug:           "code-model",
				DisplayName:    "Code Model",
				Reasoning:      true,
				SupportsImages: false,
				Pricing:        &apiPricing{InputPer1M: 1.0, OutputPer1M: 4.0},
			},
			{
				Slug:           "cheap-model",
				DisplayName:    "Cheap Model",
				Reasoning:      false,
				SupportsImages: false,
				Pricing:        &apiPricing{InputPer1M: 0.1, OutputPer1M: 0.5},
			},
		}})
	}))
	defer srv.Close()

	client := &Client{http: srv.Client(), endpoint: srv.URL}
	reg := New()

	require.NoError(t, reg.LoadFromAPI(context.Background(), client, "test-key"))

	assert.Equal(t, "big-model", reg.Main().Slug)
	assert.Equal(t, "code-model", reg.Coding().Slug)
	assert.Equal(t, "cheap-model", reg.Sub().Slug)
	assert.Len(t, reg.All(), 3)
}

func TestLoadFromAPIEmptyResponseKeepsDefaults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{Models: []apiModelEntry{}})
	}))
	defer srv.Close()

	reg := New()
	defaultMainSlug := reg.Main().Slug
	defaultCodingSlug := reg.Coding().Slug
	defaultSubSlug := reg.Sub().Slug

	client := &Client{http: srv.Client(), endpoint: srv.URL}

	require.NoError(t, reg.LoadFromAPI(context.Background(), client, "test-key"))

	assert.Equal(t, defaultMainSlug, reg.Main().Slug)
	assert.Equal(t, defaultCodingSlug, reg.Coding().Slug)
	assert.Equal(t, defaultSubSlug, reg.Sub().Slug)
}

func TestTierAssignmentFallbackWhenBucketEmpty(t *testing.T) {
	models := []Model{
		{
			Slug:           "only-reasoning-images",
			Reasoning:      true,
			SupportsImages: true,
			Pricing:        Pricing{InputPer1M: 5.0, OutputPer1M: 10.0},
		},
	}

	reg := &Registry{}
	reg.assign(models)

	assert.Equal(t, "only-reasoning-images", reg.Main().Slug)
	assert.Equal(t, "only-reasoning-images", reg.Coding().Slug)
	assert.Equal(t, "only-reasoning-images", reg.Sub().Slug)
}

func TestTierAssignmentPicksHighestCost(t *testing.T) {
	models := []Model{
		{
			Slug:           "expensive-main",
			Reasoning:      true,
			SupportsImages: true,
			Pricing:        Pricing{InputPer1M: 5.0, OutputPer1M: 20.0},
		},
		{
			Slug:           "cheap-main",
			Reasoning:      true,
			SupportsImages: true,
			Pricing:        Pricing{InputPer1M: 0.5, OutputPer1M: 2.0},
		},
		{
			Slug:           "expensive-coding",
			Reasoning:      true,
			SupportsImages: false,
			Pricing:        Pricing{InputPer1M: 3.0, OutputPer1M: 12.0},
		},
		{
			Slug:           "cheap-coding",
			Reasoning:      true,
			SupportsImages: false,
			Pricing:        Pricing{InputPer1M: 0.3, OutputPer1M: 1.0},
		},
	}

	reg := &Registry{}
	reg.assign(models)

	assert.Equal(t, "expensive-main", reg.Main().Slug)
	assert.Equal(t, "expensive-coding", reg.Coding().Slug)
}
