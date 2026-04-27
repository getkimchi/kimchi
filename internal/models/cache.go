package models

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type modelCache struct {
	Models    []Model   `json:"models"`
	FetchedAt time.Time `json:"fetched_at"`
}

func cachePath() string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(homeDir, ".config", "kimchi", "models-cache.json")
}

func saveCache(models []Model) error {
	path := cachePath()
	if path == "" {
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	cache := modelCache{Models: models, FetchedAt: time.Now()}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func loadCache() ([]Model, error) {
	path := cachePath()
	if path == "" {
		return nil, fmt.Errorf("cache path unavailable")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cache modelCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return nil, err
	}
	if len(cache.Models) == 0 {
		return nil, fmt.Errorf("cached model list is empty")
	}
	return cache.Models, nil
}
