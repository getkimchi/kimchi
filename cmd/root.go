package cmd

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"k8s.io/klog/v2"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/telemetry"
	"github.com/castai/kimchi/internal/tools"
	"github.com/castai/kimchi/internal/version"
)

var (
	debug   bool
	verbose bool
)

func newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:   "kimchi",
		Short: "Launch the Kimchi coding harness powered by open-source models",
		Long: `Kimchi
Code with powerful open-source LLMs

Running 'kimchi' launches the Kimchi coding harness — a turnkey coding agent
pre-wired to Kimchi's open-source model endpoints. The harness binary is
installed and kept up-to-date automatically alongside this CLI.

To configure another AI coding tool (OpenCode, Claude Code, Cursor, etc.) to
use Kimchi's endpoints instead, run 'kimchi setup'.
Get your API key at: https://app.kimchi.dev`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       version.String(),
		RunE:          runRoot,
	}

	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		propagateKlogFlags(root)
		initTelemetry(root)
		return nil
	}

	root.PersistentFlags().BoolVar(&debug, "debug", false, "Enable debug output")
	root.PersistentFlags().BoolVar(&verbose, "verbose", false, "Enable verbose output")

	initKlogFlags(root)

	root.AddCommand(NewVersionCommand())
	root.AddCommand(NewCompletionCommand())
	root.AddCommand(NewUpdateCommand())
	root.AddCommand(NewConfigCommand())
	root.AddCommand(NewOpenCodeCommand())
	root.AddCommand(NewCodexCommand())
	root.AddCommand(NewClaudeCommand())
	root.AddCommand(NewSetupCommand())

	return root
}

// initKlogFlags registers klog verbosity flags (-v) on the root command
func initKlogFlags(root *cobra.Command) {
	fs := flag.NewFlagSet("klog", flag.ContinueOnError)
	klog.InitFlags(fs)
	root.PersistentFlags().AddGoFlagSet(fs)
}

func initTelemetry(root *cobra.Command) {
	cfg, loadErr := config.Load()
	if loadErr != nil {
		klog.V(1).ErrorS(loadErr, "failed to load config")
		cfg = &config.Config{}
	}
	original := cfg.Clone()

	enabled, err := config.IsTelemetryEnabledFromConfig(cfg)
	if err != nil {
		klog.V(1).ErrorS(err, "failed to check telemetry status, assuming disabled")
		enabled = false
	}

	if cfg.DeviceID == "" && enabled {
		cfg.DeviceID = uuid.NewString()
	}

	client := telemetry.New(telemetry.PostHogAPIKey, enabled, cfg.DeviceID)
	ctx := telemetry.WithCtx(root.Context(), client)
	root.SetContext(ctx)

	if !cfg.TelemetryNoticeShown && enabled {
		_, _ = fmt.Fprintln(root.ErrOrStderr(),
			"INFO: Kimchi collects anonymous usage data to improve the product. "+
				"Run 'kimchi config telemetry off' to disable.")
		cfg.TelemetryNoticeShown = true
	}

	if loadErr == nil && !original.Equal(cfg) {
		if saveErr := config.Save(cfg); saveErr != nil {
			klog.V(1).ErrorS(saveErr, "failed to save config")
		}
	}

	client.Track(telemetry.NewEvent("app_started", nil))
}

// propagateKlogFlags applies the --debug or --verbose flag values to klog's -v verbosity level
func propagateKlogFlags(cmd *cobra.Command) {
	vLevel := "0"
	if verbose {
		vLevel = "2"
	} else if debug {
		vLevel = "1"
	}

	if vLevel != "0" {
		err := cmd.Flags().Set("v", vLevel)
		if err != nil {
			klog.Warningf("Failed to set verbosity level: %v", err)
		}
	}
}

func runRoot(cmd *cobra.Command, _ []string) error {
	return runHarness(cmd)
}

func Execute(args ...string) error {
	root := newRootCommand()
	if len(args) > 0 {
		root.SetArgs(args)
	}
	ctx := context.Background()
	defer func() {
		telemetry.FromCtx(root.Context()).Close()
		klog.Flush()
	}()

	err := root.ExecuteContext(ctx)
	if err != nil {
		var exitErr *tools.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.Code)
		}
	}
	return err
}
