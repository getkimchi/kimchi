package cmd

import (
	"bufio"
	"context"
	"fmt"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
	"k8s.io/klog/v2"

	"github.com/castai/kimchi/internal/update"
	"github.com/castai/kimchi/internal/version"
)

type updateDoneMsg struct{ err error }

type updateModel struct {
	spinner spinner.Model
	version string
	applyFn tea.Cmd
	err     error
	done    bool
}

func (m updateModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.applyFn)
}

func (m updateModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case updateDoneMsg:
		m.done = true
		m.err = msg.err
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m updateModel) View() string {
	if m.done {
		return ""
	}
	return m.spinner.View() + " Updating to " + m.version + "...\n"
}

type updateResult struct {
	cliUpdated bool
}

func NewUpdateCommand() *cobra.Command {
	var (
		force  bool
		dryRun bool
	)

	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update kimchi to the latest version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Explicit update command always skips cache so users see fresh results.
			_, err := runUpdate(cmd, force, dryRun, true)
			return err
		},
	}

	cmd.Flags().BoolVarP(&force, "force", "f", false, "Skip confirmation prompt")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be updated without making changes")

	return cmd
}

func runUpdate(cmd *cobra.Command, force, dryRun, skipCache bool) (*updateResult, error) {
	ctx := cmd.Context()
	res := &updateResult{}

	cliResult, err := runCLIUpdate(cmd, ctx, force, dryRun, skipCache)
	if err != nil {
		return nil, err
	}
	res.cliUpdated = cliResult.Updated

	klog.V(1).Info("checking for coding harness updates")
	runHarnessUpdate(cmd, ctx, force, dryRun, skipCache)
	return res, nil
}

func runCLIUpdate(cmd *cobra.Command, ctx context.Context, force, dryRun, skipCache bool) (*update.WorkflowResult, error) {
	var opts []update.WorkflowOpt
	if dryRun {
		opts = append(opts, update.WithDryRun())
	}
	if skipCache {
		opts = append(opts, update.WithSkipUpdateCache())
	}

	opts = append(opts,
		update.WithCurrentVersionFn(func(ctx context.Context) (*semver.Version, error) {
			if version.Version == "dev" {
				return semver.MustParse("0.0.0-dev"), nil
			}
			return semver.NewVersion(version.Version)
		}),
		update.WithConfirmFn(func(current, latest *semver.Version) (bool, error) {
			prompt := fmt.Sprintf("Kimchi update available: %s → %s\nUpdate? [Y/n]: ", current, latest)
			return confirmAction(cmd, prompt, "Update skipped.", force), nil
		}),
		update.WithProgressFn(runUpdateWithSpinner),
	)
	wf := update.NewCLIWorkflow(opts...)

	result, err := wf.Run(ctx)
	if err != nil {
		return nil, fmt.Errorf("check for kimchi updates: %w", err)
	}

	printUpdateResult(cmd, "CLI", result, dryRun)

	return result, nil
}

// runHarnessUpdate checks for the coding harness and installs or updates it.
// Failures are reported as warnings and never block the CLI update.
func runHarnessUpdate(cmd *cobra.Command, ctx context.Context, force, dryRun, skipCache bool) {
	var opts []update.WorkflowOpt
	if dryRun {
		opts = append(opts, update.WithDryRun())
	}
	if skipCache {
		opts = append(opts, update.WithSkipUpdateCache())
	}

	opts = append(opts,
		update.WithConfirmFn(func(current, latest *semver.Version) (bool, error) {
			if current == nil {
				prompt := fmt.Sprintf("Kimchi harness is not installed. Install %s? [Y/n]: ", latest)
				return confirmAction(cmd, prompt, "Install cancelled.", force), nil
			}
			prompt := fmt.Sprintf("Kimchi harness update available: %s → %s\nUpdate? [Y/n]: ", current, latest)
			return confirmAction(cmd, prompt, "Kimchi harness update skipped.", force), nil
		}),
		update.WithProgressFn(runUpdateWithSpinner),
	)
	wf := update.NewHarnessWorkflow(opts...)
	result, err := wf.Run(ctx)
	if err != nil {
		_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "Warning: %v\n", err)
		return
	}

	printUpdateResult(cmd, "Coding harness", result, dryRun)
}

func printUpdateResult(cmd *cobra.Command, label string, result *update.WorkflowResult, dryRun bool) {
	switch {
	case result.Updated && result.FreshInstall():
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "✓ %s installed: %s\n", label, result.AvailableVersion)
	case result.Updated:
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "✓ %s updated to %s\n", label, result.AvailableVersion)
	case dryRun && result.FreshInstall():
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s: not installed, latest version is %s (would install)\n", label, result.AvailableVersion)
	case dryRun && result.HasUpdate():
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s update available: %s → %s\n", label, result.InstalledVersion, result.AvailableVersion)
	case !result.HasUpdate() && result.InstalledVersion != nil:
		_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s: already up to date (%s)\n", label, result.InstalledVersion)
	}
}

func confirmAction(cmd *cobra.Command, prompt, cancelMsg string, force bool) bool {
	if force {
		return true
	}
	_, _ = fmt.Fprint(cmd.OutOrStdout(), prompt)
	reader := bufio.NewReader(cmd.InOrStdin())
	answer, _ := reader.ReadString('\n')
	answer = strings.TrimSpace(strings.ToLower(answer))
	if answer != "" && answer != "y" && answer != "yes" {
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), cancelMsg)
		return false
	}
	return true
}

func runUpdateWithSpinner(version string, applyFn func() error) error {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))
	m := updateModel{
		spinner: s,
		version: version,
		applyFn: func() tea.Msg {
			return updateDoneMsg{err: applyFn()}
		},
	}
	finalModel, err := tea.NewProgram(m).Run()
	if err != nil {
		return fmt.Errorf("run update: %w", err)
	}
	if fm, ok := finalModel.(updateModel); ok && fm.err != nil {
		return fm.err
	}
	return nil
}
