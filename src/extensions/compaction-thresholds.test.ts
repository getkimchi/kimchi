import { describe, expect, it } from "vitest"
import { COMPACTION_RESERVE_TOKENS } from "./compaction-thresholds.js"

describe("COMPACTION_RESERVE_TOKENS", () => {
	it("equals the upstream default reserve of 16,384 tokens", () => {
		expect(COMPACTION_RESERVE_TOKENS).toBe(16_384)
	})
})
