package cmd

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
	klog "k8s.io/klog/v2"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/provider/codex"
	"github.com/castai/kimchi/internal/tools"
)

func NewCodexCommand() *cobra.Command {
	return &cobra.Command{
		Use:                "codex [flags and args for codex]",
		Short:              "Launch Codex with Kimchi models",
		Long:               "Wraps the Codex CLI, injecting Kimchi configuration via environment variables.\nAll arguments are passed through to the codex binary.",
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

			reg := models.New()
			if apiKey != "" {
				client := models.NewClient(nil)
				ctx, cancel := context.WithTimeout(cmd.Context(), 15*time.Second)
				defer cancel()
				if err := reg.LoadFromAPI(ctx, client, apiKey); err != nil {
					klog.V(1).ErrorS(err, "failed to load models from API, using defaults")
				}
			}
			tools.SetRegistry(reg)

			printBanner(os.Stderr, tools.ToolCodex, cfg)

			env, err := codex.Env(apiKey)
			if err != nil {
				return fmt.Errorf("prepare codex environment: %w", err)
			}

			return tools.ExecTool("codex", args, env)
		},
	}
}
