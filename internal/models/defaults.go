package models

func DefaultModels() []Model {
	return []Model{
		{
			Slug:            "kimi-k2.5",
			DisplayName:     "Kimi K2.5",
			Description:     "Primary model for reasoning, planning, code generation, and image processing.",
			ToolCall:        true,
			Reasoning:       true,
			SupportsImages:  true,
			InputModalities: []string{"text", "image"},
			Limits:          Limits{ContextWindow: 262144, MaxOutputTokens: 32768},
			Pricing:         Pricing{InputPer1M: 0.6, OutputPer1M: 3.0},
		},
		{
			Slug:            "nemotron-3-super-fp4",
			DisplayName:     "Nemotron 3 Super FP4",
			Description:     "High-performance reasoning model for complex tasks.",
			ToolCall:        true,
			Reasoning:       true,
			SupportsImages:  false,
			InputModalities: []string{"text"},
			Limits:          Limits{ContextWindow: 1048576, MaxOutputTokens: 256000},
			Pricing:         Pricing{InputPer1M: 0.8, OutputPer1M: 4.0},
		},
		{
			Slug:            "minimax-m2.7",
			DisplayName:     "MiniMax M2.7",
			Description:     "Secondary subagent for code generation and debugging.",
			ToolCall:        true,
			Reasoning:       true,
			SupportsImages:  false,
			InputModalities: []string{"text"},
			Limits:          Limits{ContextWindow: 196608, MaxOutputTokens: 32768},
			Pricing:         Pricing{InputPer1M: 0.3, OutputPer1M: 1.2},
		},
	}
}
