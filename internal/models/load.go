package models

import (
	"context"

	klog "k8s.io/klog/v2"
)

// Load creates a Registry and attempts to populate it from the API.
// On failure, it tries the local cache. If both fail, defaults are used.
// If apiKey is empty, defaults are used immediately.
func Load(ctx context.Context, apiKey string) *Registry {
	reg := New()
	if apiKey == "" {
		return reg
	}
	client := NewClient(nil)
	if err := reg.LoadFromAPI(ctx, client, apiKey); err != nil {
		klog.V(1).ErrorS(err, "failed to load models from API, trying cache")
		if cached, cacheErr := loadCache(); cacheErr == nil {
			reg.assign(cached)
			klog.V(1).Info("loaded models from cache")
		} else {
			klog.V(1).ErrorS(cacheErr, "failed to load models from cache, using defaults")
		}
	}
	return reg
}
