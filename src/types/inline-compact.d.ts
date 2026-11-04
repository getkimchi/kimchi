// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import type { InlineCompactOptions } from "../upstream-inline-compact-patch.js"

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionContext {
		inlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
