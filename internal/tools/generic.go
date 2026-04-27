package tools

import "github.com/castai/kimchi/internal/config"

func init() {
	register(Tool{
		ID:          ToolGeneric,
		Name:        "Generic",
		Description: "Export env vars (stdout)",
		ConfigPath:  "",
		BinaryName:  "",
		IsInstalled: func() bool { return false },
		// Generic has no on-disk config; the env-var instructions are
		// rendered inside the TUI. A no-op Write keeps the invariant that
		// every registered tool has a writer, so an accidentally missing
		// Write on a future tool still surfaces as an error.
		Write: func(_ config.ConfigScope, _ string) error { return nil },
	})
}
