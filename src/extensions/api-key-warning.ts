// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

export default function createApiKeyWarningExtension(warning: string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (event, ctx) => {
			if (warning && event.reason === "startup" && ctx.hasUI) ctx.ui.notify(warning, "warning")
		})
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
