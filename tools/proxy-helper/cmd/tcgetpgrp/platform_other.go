//go:build !darwin && !linux

package tcgetpgrp

import "fmt"

func frontmostPIDPlatform() (int, error) {
	return 0, fmt.Errorf("unsupported platform")
}
