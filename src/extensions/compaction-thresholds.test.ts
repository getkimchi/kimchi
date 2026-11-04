// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { COMPACTION_RESERVE_TOKENS } from "./compaction-thresholds.js"

describe("COMPACTION_RESERVE_TOKENS", () => {
	it("equals the upstream default reserve of 16,384 tokens", () => {
		expect(COMPACTION_RESERVE_TOKENS).toBe(16_384)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
