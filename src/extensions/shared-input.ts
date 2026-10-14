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

/**
 * Claim raw input capture for the duration of an async operation (typically
 * an interactive prompt that owns the keyboard). Use this when a focused form
 * handles navigation keys — Shift+Tab, Ctrl+P — that are ALSO bound to global
 * shortcuts registered via ctx.ui.onTerminalInput. Upstream pi-tui dispatches
 * raw input to onTerminalInput listeners BEFORE the focused component, so
 * without this claim a Shift+Tab inside a questionnaire both navigates the
 * form and gets consumed by the permissions mode-cycle listener (the mode
 * flips and the form never sees the key).
 *
 * Permission prompts deliberately do NOT claim: Shift+Tab cycling while a
 * permission prompt is open is a feature (LLM-1454).
 */
export async function withRawInputCapture<T>(fn: () => Promise<T>): Promise<T> {
	const release = claimRawInputCapture()
	try {
		return await fn()
	} finally {
		release()
	}
}
