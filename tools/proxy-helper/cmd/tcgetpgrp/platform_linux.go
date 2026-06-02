package tcgetpgrp

import (
	"os/exec"
	"strconv"
	"strings"
)

func frontmostPIDPlatform() (int, error) {
	winID, err := exec.Command("xdotool", "getactivewindow").Output()
	if err != nil {
		return 0, err
	}
	out, err := exec.Command("xdotool", "getwindowpid", strings.TrimSpace(string(winID))).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}
