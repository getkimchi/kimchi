// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ToolRenderContext } from "../tool-rendering.js"

export function createToolRenderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		toolCallId: "test-tool-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		...overrides,
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
