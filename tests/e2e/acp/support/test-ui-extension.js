// Test extension that exercises ctx.ui.notify and ctx.ui.setStatus on
// session_start. Pi auto-loads any file under <agentDir>/extensions/.

export default (pi) => {
	pi.on("session_start", async (_event, ctx) => {
		// Swallow errors — extensions shouldn't surface transport failures.
		try {
			ctx.ui.notify("test-notify", "info")
		} catch {}
		try {
			ctx.ui.setStatus("test-key", "test-value")
		} catch {}
	})
}
