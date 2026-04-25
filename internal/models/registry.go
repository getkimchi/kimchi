package models

import (
	"context"
	"fmt"
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
		return nil
	}
	r.assign(fetched)
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
	return DefaultModels()[0]
}

func (r *Registry) Coding() Model {
	if r.coding != nil {
		return *r.coding
	}
	return DefaultModels()[1]
}

func (r *Registry) Sub() Model {
	if r.sub != nil {
		return *r.sub
	}
	return DefaultModels()[2]
}

func (r *Registry) assign(models []Model) {
	r.all = models

	var mainCandidates, codingCandidates, subCandidates []Model
	for _, m := range models {
		switch {
		case m.Reasoning && m.SupportsImages:
			mainCandidates = append(mainCandidates, m)
		case m.Reasoning && !m.SupportsImages:
			codingCandidates = append(codingCandidates, m)
		default:
			subCandidates = append(subCandidates, m)
		}
	}

	bestOverall, hasBest := bestByPrice(models)

	if len(mainCandidates) > 0 {
		m, _ := bestByPrice(mainCandidates)
		r.main = &m
	} else if hasBest {
		m := bestOverall
		r.main = &m
	}

	if len(codingCandidates) > 0 {
		m, _ := bestByPrice(codingCandidates)
		r.coding = &m
	} else if hasBest {
		m := bestOverall
		r.coding = &m
	}

	if len(subCandidates) > 0 {
		m, _ := bestByPrice(subCandidates)
		r.sub = &m
	} else if hasBest {
		m := bestOverall
		r.sub = &m
	}
}

func bestByPrice(models []Model) (Model, bool) {
	if len(models) == 0 {
		return Model{}, false
	}
	best := models[0]
	bestCost := models[0].Pricing.InputPer1M + models[0].Pricing.OutputPer1M
	for i := 1; i < len(models); i++ {
		cost := models[i].Pricing.InputPer1M + models[i].Pricing.OutputPer1M
		if cost > bestCost {
			bestCost = cost
			best = models[i]
		}
	}
	return best, true
}
