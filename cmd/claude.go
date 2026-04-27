package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/provider/claudecode"
	"github.com/castai/kimchi/internal/tools"
)

func NewClaudeCommand() *cobra.Command {
	return &cobra.Command{
		Use:                "claude [flags and args for claude]",
		Short:              "Launch Claude Code with Kimchi models",
		Long:               "Wraps the Claude Code CLI, injecting Kimchi configuration via environment variables.\nAll arguments are passed through to the claude binary.",
		DisableFlagParsing: true,
		SilenceUsage:       true,
		SilenceErrors:      true,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			apiKey, err := config.ResolveAPIKey(cfg)
			if err != nil {
				return err
			}

			reg := models.Load(cmd.Context(), apiKey)
			tools.SetRegistry(reg)

			printBanner(os.Stderr, tools.ToolClaudeCode, cfg)

			env := claudecode.Env(apiKey)

			return tools.ExecTool("claude", args, env)
		},
	}
}
