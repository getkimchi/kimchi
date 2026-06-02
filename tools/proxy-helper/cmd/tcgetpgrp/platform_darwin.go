package tcgetpgrp

func frontmostPIDPlatform() (int, error) {
	return frontmostPIDDarwin()
}
