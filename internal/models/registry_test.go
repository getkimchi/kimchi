package models

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewRegistryFromDefaults(t *testing.T) {
	reg := New()

	if reg.Main().Slug == "" {
		t.Fatal("Main() returned empty slug")
	}
	if reg.Coding().Slug == "" {
		t.Fatal("Coding() returned empty slug")
	}
	if reg.Sub().Slug == "" {
		t.Fatal("Sub() returned empty slug")
	}
	if len(reg.All()) == 0 {
		t.Fatal("All() returned empty slice")
	}

	main := reg.Main()
	if !main.Reasoning || !main.SupportsImages {
		t.Errorf("Main() should be reasoning+images model, got reasoning=%v supportsImages=%v", main.Reasoning, main.SupportsImages)
	}

	coding := reg.Coding()
	if !coding.Reasoning {
		t.Errorf("Coding() should be reasoning model, got reasoning=%v", coding.Reasoning)
	}

	if main.Slug == coding.Slug {
		t.Errorf("Main and Coding should be different models, both are %q", main.Slug)
	}
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
	if !kimiFound || !nemotronFound || !minimaxFound {
		t.Fatal("defaults missing expected models")
	}

	if mainSlug != "kimi-k2.5" {
		t.Errorf("expected Main=kimi-k2.5, got %q", mainSlug)
	}
	if codingSlug != "nemotron-3-super-fp4" {
		t.Errorf("expected Coding=nemotron-3-super-fp4, got %q", codingSlug)
	}

	// minimax-m2.7 has reasoning=true so it is a coding candidate, not sub.
	// With no non-reasoning models in defaults, sub falls back to the best overall (kimi-k2.5).
	subSlug := reg.Sub().Slug
	if subSlug == "" {
		t.Error("Sub() returned empty slug")
	}
}

func TestLoadFromAPISuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the client sets auth headers correctly.
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("expected Authorization header 'Bearer test-key', got %q", got)
		}

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

	if err := reg.LoadFromAPI(context.Background(), client, "test-key"); err != nil {
		t.Fatalf("LoadFromAPI failed: %v", err)
	}

	if reg.Main().Slug != "big-model" {
		t.Errorf("expected Main=big-model, got %q", reg.Main().Slug)
	}
	if reg.Coding().Slug != "code-model" {
		t.Errorf("expected Coding=code-model, got %q", reg.Coding().Slug)
	}
	if reg.Sub().Slug != "cheap-model" {
		t.Errorf("expected Sub=cheap-model, got %q", reg.Sub().Slug)
	}
	if len(reg.All()) != 3 {
		t.Errorf("expected 3 models, got %d", len(reg.All()))
	}
}

func TestLoadFromAPIEmptyResponseKeepsDefaults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{Models: []apiModelEntry{}})
	}))
	defer srv.Close()

	reg := New()
	defaultMain := reg.Main().Slug
	defaultCoding := reg.Coding().Slug
	defaultSub := reg.Sub().Slug

	client := &Client{http: srv.Client(), endpoint: srv.URL}

	if err := reg.LoadFromAPI(context.Background(), client, "test-key"); err != nil {
		t.Fatalf("LoadFromAPI failed: %v", err)
	}

	if reg.Main().Slug != defaultMain {
		t.Errorf("Main changed after empty API response: got %q, want %q", reg.Main().Slug, defaultMain)
	}
	if reg.Coding().Slug != defaultCoding {
		t.Errorf("Coding changed after empty API response: got %q, want %q", reg.Coding().Slug, defaultCoding)
	}
	if reg.Sub().Slug != defaultSub {
		t.Errorf("Sub changed after empty API response: got %q, want %q", reg.Sub().Slug, defaultSub)
	}
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

	if reg.Main().Slug != "only-reasoning-images" {
		t.Errorf("expected Main=only-reasoning-images, got %q", reg.Main().Slug)
	}
	if reg.Coding().Slug != "only-reasoning-images" {
		t.Errorf("expected Coding to fallback to only model, got %q", reg.Coding().Slug)
	}
	if reg.Sub().Slug != "only-reasoning-images" {
		t.Errorf("expected Sub to fallback to only model, got %q", reg.Sub().Slug)
	}
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

	if reg.Main().Slug != "expensive-main" {
		t.Errorf("expected Main=expensive-main, got %q", reg.Main().Slug)
	}
	if reg.Coding().Slug != "expensive-coding" {
		t.Errorf("expected Coding=expensive-coding, got %q", reg.Coding().Slug)
	}
}
