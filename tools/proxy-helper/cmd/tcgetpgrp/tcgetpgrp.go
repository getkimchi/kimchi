package tcgetpgrp

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func NewTcgetpgrpCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "tcgetpgrp",
		Short: "Exit 0 if the terminal window is focused, 1 otherwise",
		RunE: func(cmd *cobra.Command, args []string) error {
			focused, err := isTerminalFocused()
			if err != nil || !focused {
				os.Exit(1)
			}
			os.Exit(0)
			return nil
		},
	}
}

func isTerminalFocused() (bool, error) {
	frontPID, err := frontmostPID()
	if err != nil {
		return false, err
	}
	return isAncestor(frontPID, os.Getpid())
}

// frontmostPID returns the PID of the frontmost application.
// Platform-specific implementations provide frontmostPIDDarwin / frontmostPIDLinux.
func frontmostPID() (int, error) {
	pid, err := frontmostPIDPlatform()
	if err != nil {
		return 0, fmt.Errorf("frontmost pid: %w", err)
	}
	return pid, nil
}

// isAncestor returns true if ancestorPID is in the parent chain of pid.
func isAncestor(ancestorPID, pid int) (bool, error) {
	current := pid
	for current > 1 {
		if current == ancestorPID {
			return true, nil
		}
		ppid, err := getppid(current)
		if err != nil {
			return false, err
		}
		current = ppid
	}
	return false, nil
}

func getppid(pid int) (int, error) {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}
