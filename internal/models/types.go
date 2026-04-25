package models

type Model struct {
	Slug            string
	DisplayName     string
	Description     string
	ToolCall        bool
	Reasoning       bool
	SupportsImages  bool
	InputModalities []string
	Limits          Limits
	Pricing         Pricing
}

type Limits struct {
	ContextWindow   int
	MaxOutputTokens int
}

type Pricing struct {
	InputPer1M  float64
	OutputPer1M float64
}
