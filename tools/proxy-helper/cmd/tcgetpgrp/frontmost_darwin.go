package tcgetpgrp

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
#import <AppKit/AppKit.h>

int frontmostAppPID() {
	NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
	if (app == nil) return -1;
	return (int)app.processIdentifier;
}
*/
import "C"

func frontmostPIDDarwin() (int, error) {
	pid := int(C.frontmostAppPID())
	if pid < 0 {
		return 0, nil
	}
	return pid, nil
}
