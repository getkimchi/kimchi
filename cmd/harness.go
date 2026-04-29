package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"k8s.io/klog/v2"

	"github.com/castai/kimchi/internal/auth"
	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/telemetry"
	"github.com/castai/kimchi/internal/tools"
	"github.com/castai/kimchi/internal/update"
)

func runHarness(cmd *cobra.Command, args []string) error {
	ctx := cmd.Context()

	harnessPath, err := update.ResolveHarnessPath()
	if err != nil {
		return fmt.Errorf("resolve harness path: %w", err)
	}

	// If update checks are disabled, skip straight to launch.
	if update.IsUpdateCheckDisabled() {
		if !update.HarnessInstalled(harnessPath) {
			return fmt.Errorf("coding harness is not installed and update checks are disabled — " +
				"unset KIMCHI_NO_UPDATE_CHECK or install the harness manually")
		}
		return launchHarness(cmd, harnessPath, args)
	}

	// Reuse the update command logic for CLI + harness updates.
	// Uses cache (skipCache=false) since harness launches happen frequently.
	if _, err := runUpdate(cmd, false, false, false); err != nil {
		return err
	}

	// If the harness is not installed (e.g. user declined, or fetch failed), exit
	// gracefully instead of treating it as a fatal error.
	if !update.HarnessInstalled(harnessPath) {
		return nil
	}

	var props map[string]any
	if v, err := update.HarnessCurrentVersion(ctx); err == nil && v != nil {
		props = map[string]any{"version": v.String()}
	}
	telemetry.FromCtx(ctx).Track(telemetry.NewEvent("harness_launched", props))

	return launchHarness(cmd, harnessPath, args)
}

// launchHarness resolves the API key (prompting if missing), ensures it is
// saved in the config file, and execs into the harness binary.
func launchHarness(cmd *cobra.Command, harnessPath string, args []string) error {
	ctx := cmd.Context()

	apiKey, err := config.GetAPIKey()
	if err != nil {
		return fmt.Errorf("resolve API key: %w", err)
	}

	// If no key is found, prompt the user to enter one.
	if apiKey == "" {
		apiKey, err = promptAndValidateAPIKey(cmd, ctx)
		if err != nil {
			return err
		}
	}

	// Ensure the API key is persisted in the config file so the harness can
	// read it. This is a no-op when the key already came from config; it
	// covers the first run experience.
	if err := config.SetAPIKey(apiKey); err != nil {
		_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not save API key: %v\n", err)
	}

	klog.V(1).InfoS("launching coding harness", "path", harnessPath)
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), "Launching coding harness...")

	if err := tools.ExecBinary(harnessPath, args, nil); err != nil {
		return fmt.Errorf("launch coding harness: %w", err)
	}

	// On Unix, ExecBinary replaces the process so we never reach here.
	// On Windows, ExecBinary returns after the child exits.
	return nil
}

// promptAndValidateAPIKey prompts the user for an API key via stdin, validates
// it, and saves it to the config file.
func promptAndValidateAPIKey(cmd *cobra.Command, ctx context.Context) (string, error) {
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), "You need an API key to use the coding harness.")
	_, _ = fmt.Fprintln(cmd.OutOrStdout(), "Get your API key at: https://app.kimchi.dev")
	_, _ = fmt.Fprint(cmd.OutOrStdout(), "Enter API key: ")

	apiKey, err := readAPIKeyFromStdin()
	if err != nil {
		return "", fmt.Errorf("read API key: %w", err)
	}

	if apiKey == "" {
		return "", fmt.Errorf("API key is required to launch the coding harness")
	}

	v := auth.NewValidator(nil)
	result, err := v.ValidateAPIKey(ctx, apiKey)
	if err != nil {
		return "", fmt.Errorf("validate API key: %w", err)
	}
	if !result.Valid {
		msg := fmt.Sprintf("✗ %s", result.Error)
		for _, s := range result.Suggestions {
			msg += fmt.Sprintf("\n  • %s", s)
		}
		return "", fmt.Errorf("%s", msg)
	}

	return apiKey, nil
}

// readAPIKeyFromStdin reads a single line from stdin and trims whitespace.
func readAPIKeyFromStdin() (string, error) {
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}
