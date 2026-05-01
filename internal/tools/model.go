package tools

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

var (
	// MainModel is the primary model for reasoning, planning, code generation, and image processing.
	MainModel = model{
		Slug:            "kimi-k2.6",
		displayName:     "Kimi K2.6",
		description:     "Primary model for reasoning, planning, code generation, and image processing.",
		toolCall:        true,
		reasoning:       true,
		supportsImages:  true,
		inputModalities: []string{"text", "image"},
		limits:          limits{contextWindow: 262144, maxOutputTokens: 32768},
	}
	// CodingModel is the coding subagent used where tools require a fixed model value for code tasks.
	CodingModel = model{
		Slug:            "nemotron-3-super-fp4",
		displayName:     "Nemotron 3 Super FP4",
		description:     "High-performance reasoning model for complex tasks.",
		toolCall:        true,
		reasoning:       true,
		inputModalities: []string{"text"},
		limits:          limits{contextWindow: 1048576, maxOutputTokens: 256000},
	}
	// SubModel is the secondary subagent available across all tool installations.
	SubModel = model{
		Slug:            "minimax-m2.7",
		displayName:     "MiniMax M2.7",
		description:     "Secondary subagent for code generation and debugging.",
		toolCall:        true,
		reasoning:       true,
		inputModalities: []string{"text"},
		limits:          limits{contextWindow: 196608, maxOutputTokens: 32768},
	}
	// OpusModel is the high-capability model for planning and validation tasks.
	OpusModel = model{
		Slug:            "claude-opus-4-6",
		displayName:     "Claude Opus 4.6",
		description:     "High-capability model for complex planning and validation tasks.",
		toolCall:        true,
		reasoning:       true,
		inputModalities: []string{"text"},
		limits:          limits{contextWindow: 1000000, maxOutputTokens: 128000},
	}
	// SonnetModel is the balanced model for general tasks.
	SonnetModel = model{
		Slug:            "claude-sonnet-4-6",
		displayName:     "Claude Sonnet 4.6",
		description:     "Balanced model for general reasoning and code tasks.",
		toolCall:        true,
		reasoning:       true,
		inputModalities: []string{"text"},
		limits:          limits{contextWindow: 1000000, maxOutputTokens: 128000},
	}
	// KimiK25Model is the previous Kimi model for reasoning and code generation.
	KimiK25Model = model{
		Slug:            "kimi-k2.5",
		displayName:     "Kimi K2.5",
		description:     "Previous Kimi model for reasoning, planning, and code generation.",
		toolCall:        true,
		reasoning:       true,
		supportsImages:  true,
		inputModalities: []string{"text", "image"},
		limits:          limits{contextWindow: 262144, maxOutputTokens: 32768},
	}

	allModels = []model{MainModel, CodingModel, SubModel, OpusModel, SonnetModel, KimiK25Model}
)
