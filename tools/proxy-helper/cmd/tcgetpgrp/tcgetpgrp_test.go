package tcgetpgrp

import (
	"os"
	"os/exec"
	"testing"
)

func TestIsAncestor_selfIsAncestorOfSelf(t *testing.T) {
	pid := os.Getpid()
	ok, err := isAncestor(pid, pid)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected pid to be an ancestor of itself")
	}
}

func TestIsAncestor_parentIsAncestor(t *testing.T) {
	ppid := os.Getppid()
	pid := os.Getpid()
	ok, err := isAncestor(ppid, pid)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Errorf("expected ppid %d to be an ancestor of pid %d", ppid, pid)
	}
}

func TestIsAncestor_unrelatedPIDIsNotAncestor(t *testing.T) {
	// Spawn a child process that does nothing, then verify it is not an
	// ancestor of us (we are its ancestor, not the other way around).
	cmd := exec.Command("sleep", "1")
	if err := cmd.Start(); err != nil {
		t.Skip("cannot start child process:", err)
	}
	defer cmd.Process.Kill() //nolint:errcheck
	childPID := cmd.Process.Pid

	ok, err := isAncestor(childPID, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Errorf("child pid %d should not be an ancestor of parent pid %d", childPID, os.Getpid())
	}
}

func TestIsAncestor_pid1IsNotAncestorOfUs(t *testing.T) {
	// PID 1 is not in our direct ancestor chain on macOS (launchd forks daemons,
	// not user shells), but it may be on some Linux setups. This test only
	// verifies the walk terminates without error.
	_, err := isAncestor(1, os.Getpid())
	if err != nil {
		t.Error("unexpected error walking to pid 1:", err)
	}
}

func TestGetppid_matchesOsGetppid(t *testing.T) {
	got, err := getppid(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	want := os.Getppid()
	if got != want {
		t.Errorf("getppid(%d) = %d, want %d", os.Getpid(), got, want)
	}
}

func TestIsTerminalFocused_returnsWithoutPanic(t *testing.T) {
	// We can't assert a specific value (depends on which window is focused),
	// but it must not panic or return an error that crashes.
	focused, err := isTerminalFocused()
	if err != nil {
		// Acceptable on CI where there's no window server.
		t.Logf("isTerminalFocused returned err (expected on headless): %v", err)
		return
	}
	t.Logf("isTerminalFocused = %v", focused)
}
