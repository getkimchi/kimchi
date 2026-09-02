// Test extension that exercises ctx.ui.confirm, ctx.ui.select, and
// ctx.ui.input on session_start. Used by elicitation-dialogs.test.ts to
// drive the elicitation wire path end-to-end.
//
// All three calls are awaited sequentially so the test can observe the
// elicitation/create requests in arrival order. Results are accepted with
// sensible defaults so the harness keeps starting up regardless of client UI.

export default (pi) => {
	pi.on("session_start", async (_event, ctx) => {
		// Swallow errors — extensions shouldn't surface transport failures.
		try {
			await ctx.ui.confirm("Proceed?", "This dialog exercises elicitation wire shape.")
		} catch {}
		try {
			await ctx.ui.select("Pick a colour", ["red", "green", "blue"])
		} catch {}
		try {
			await ctx.ui.input("Workspace name", "e.g. my-project")
		} catch {}
	})
}
