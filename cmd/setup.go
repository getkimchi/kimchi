package cmd

import (
	"github.com/spf13/cobra"

	"github.com/castai/kimchi/internal/tui"
)

func NewSetupCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Run the interactive setup wizard",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := tui.RunWizard(cmd.Context())
			return err
		},
	}
}
