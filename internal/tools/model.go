package tools

import "github.com/castai/kimchi/internal/models"

type limits struct {
	contextWindow   int
	maxOutputTokens int
}

type model struct {
	Slug            string
	displayName     string
	description     string
	toolCall        bool
	reasoning       bool
	supportsImages  bool
	inputModalities []string
	limits          limits
}

func fromRegistryModel(m models.Model) model {
	return model{
		Slug:            m.Slug,
		displayName:     m.DisplayName,
		description:     m.Description,
		toolCall:        m.ToolCall,
		reasoning:       m.Reasoning,
		supportsImages:  m.SupportsImages,
		inputModalities: m.InputModalities,
		limits: limits{
			contextWindow:   m.Limits.ContextWindow,
			maxOutputTokens: m.Limits.MaxOutputTokens,
		},
	}
}

var (
	MainModel   model
	CodingModel model
	SubModel    model
	allModels   []model
)

func init() {
	reg := models.New()
	setFromRegistry(reg)
}

// SetRegistry repopulates the package-level model variables from the given
// registry. It is NOT safe for concurrent use — call it before any concurrent
// access to MainModel, CodingModel, SubModel, or allModels begins (e.g. during
// initialisation, before tool config writes are dispatched).
func SetRegistry(reg *models.Registry) {
	setFromRegistry(reg)
}

func setFromRegistry(reg *models.Registry) {
	MainModel = fromRegistryModel(reg.Main())
	CodingModel = fromRegistryModel(reg.Coding())
	SubModel = fromRegistryModel(reg.Sub())
	all := reg.All()
	allModels = make([]model, len(all))
	for i, m := range all {
		allModels[i] = fromRegistryModel(m)
	}
}
