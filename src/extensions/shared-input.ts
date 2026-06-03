let rawInputCaptureCount = 0

/**
 * Claim exclusive raw terminal input. While at least one claim is held,
 * global shortcut listeners (e.g. Shift+Tab cycle mode, Ctrl+P cycle model)
 * defer to the foreground UI that took the claim — typically a full-screen
 * input forwarder such as the teleport overlay.
 *
 * Returns a release function. Multiple concurrent claims are supported via
 * reference count; releasing the same function twice is a no-op.
 */
export function claimRawInputCapture(): () => void {
	rawInputCaptureCount++
	let released = false
	return () => {
		if (released) return
		released = true
		rawInputCaptureCount = Math.max(0, rawInputCaptureCount - 1)
	}
}

export function isRawInputCaptureActive(): boolean {
	return rawInputCaptureCount > 0
}
