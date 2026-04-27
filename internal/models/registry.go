package models

import (
	"context"
	"fmt"

	klog "k8s.io/klog/v2"
)

type Registry struct {
	all    []Model
	main   *Model
	coding *Model
	sub    *Model
}

func New() *Registry {
	r := &Registry{}
	r.assign(DefaultModels())
	return r
}

func (r *Registry) LoadFromAPI(ctx context.Context, client *Client, apiKey string) error {
	fetched, err := client.FetchModels(ctx, apiKey)
	if err != nil {
		return fmt.Errorf("fetch models: %w", err)
	}
	if len(fetched) == 0 {
		klog.V(1).Info("API returned zero models, keeping current registry state")
		return nil
	}
	r.assign(fetched)
	if err := saveCache(fetched); err != nil {
		klog.V(1).ErrorS(err, "failed to save models cache")
	}
	return nil
}

func (r *Registry) All() []Model {
	result := make([]Model, len(r.all))
	copy(result, r.all)
	return result
}

func (r *Registry) Main() Model {
	if r.main != nil {
		return *r.main
	}
	return defaultMain
}

func (r *Registry) Coding() Model {
	if r.coding != nil {
		return *r.coding
	}
	return defaultCoding
}

func (r *Registry) Sub() Model {
	if r.sub != nil {
		return *r.sub
	}
	return defaultSub
}

func (r *Registry) assign(models []Model) {
	r.all = models

	var mainCandidates, codingCandidates, subCandidates []Model
	for _, m := range models {
		switch {
		case m.Tier == "main":
			mainCandidates = append(mainCandidates, m)
		case m.Tier == "coding":
			codingCandidates = append(codingCandidates, m)
		case m.Tier == "sub":
			subCandidates = append(subCandidates, m)
		case m.Reasoning && m.SupportsImages:
			mainCandidates = append(mainCandidates, m)
		case m.Reasoning:
			codingCandidates = append(codingCandidates, m)
		default:
			subCandidates = append(subCandidates, m)
		}
	}

	bestOverall, hasBest := mostExpensive(models)

	if len(mainCandidates) > 0 {
		m, _ := mostExpensive(mainCandidates)
		r.main = &m
	} else if hasBest {
		m := bestOverall
		r.main = &m
	}

	if len(codingCandidates) > 0 {
		m, _ := mostExpensive(codingCandidates)
		r.coding = &m
	} else if hasBest {
		m := bestOverall
		r.coding = &m
	}

	if len(subCandidates) > 0 {
		m, _ := mostExpensive(subCandidates)
		r.sub = &m
	} else if hasBest {
		m := bestOverall
		r.sub = &m
	}
}

// mostExpensive returns the model with the highest weighted cost. Input tokens
// are weighted more heavily (80%) because they dominate real-world usage for
// large-context models. Higher cost is used as a proxy for model quality/capability.
func mostExpensive(models []Model) (Model, bool) {
	if len(models) == 0 {
		return Model{}, false
	}
	best := models[0]
	bestCost := weightedCost(models[0])
	for i := 1; i < len(models); i++ {
		cost := weightedCost(models[i])
		if cost > bestCost {
			bestCost = cost
			best = models[i]
		}
	}
	return best, true
}

// weightedCost computes a blended cost score. Input tokens are weighted more
// heavily (80%) because they dominate real-world usage for large-context models.
func weightedCost(m Model) float64 {
	return 0.8*m.Pricing.InputPer1M + 0.2*m.Pricing.OutputPer1M
}
