import { describe, expect, it } from "vitest"
import { authoredEnabled, factClassesEnabled, parseBooleanFlag, staleAwareDigestEnabled } from "./flags.js"

describe("parseBooleanFlag", () => {
	it("truthy grammar: any non-empty non-0 non-false value enables", () => {
		expect(parseBooleanFlag({ X: "1" }, "X")).toBe(true)
		expect(parseBooleanFlag({ X: "true" }, "X")).toBe(true)
		expect(parseBooleanFlag({ X: "yes" }, "X")).toBe(true)
		expect(parseBooleanFlag({ X: "TRUE" }, "X")).toBe(true)
	})

	it("truthy grammar: unset, empty, 0, false (any case) stay off", () => {
		expect(parseBooleanFlag({}, "X")).toBe(false)
		expect(parseBooleanFlag({ X: "" }, "X")).toBe(false)
		expect(parseBooleanFlag({ X: "0" }, "X")).toBe(false)
		expect(parseBooleanFlag({ X: "false" }, "X")).toBe(false)
		expect(parseBooleanFlag({ X: "FALSE" }, "X")).toBe(false)
	})

	it("strict grammar: only the literal 1 enables", () => {
		expect(parseBooleanFlag({ X: "1" }, "X", { strict: true })).toBe(true)
		expect(parseBooleanFlag({ X: "true" }, "X", { strict: true })).toBe(false)
		expect(parseBooleanFlag({ X: "yes" }, "X", { strict: true })).toBe(false)
		expect(parseBooleanFlag({ X: "10" }, "X", { strict: true })).toBe(false)
		expect(parseBooleanFlag({}, "X", { strict: true })).toBe(false)
	})
})

describe("lane predicates (shared parse points)", () => {
	it("factClassesEnabled + authoredEnabled + staleAwareDigestEnabled use the truthy grammar", () => {
		for (const pred of [factClassesEnabled, authoredEnabled, staleAwareDigestEnabled]) {
			expect(pred({})).toBe(false)
		}
		expect(factClassesEnabled({ KIMCHI_MEMORY_FACT_CLASSES: "1" })).toBe(true)
		expect(factClassesEnabled({ KIMCHI_MEMORY_FACT_CLASSES: "0" })).toBe(false)
		expect(authoredEnabled({ KIMCHI_MEMORY_AUTHORED: "true" })).toBe(true)
		expect(staleAwareDigestEnabled({ KIMCHI_MEMORY_STALE_AWARE_DIGEST: "yes" })).toBe(true)
		expect(staleAwareDigestEnabled({ KIMCHI_MEMORY_STALE_AWARE_DIGEST: "no" })).toBe(true) // non-falsey non-0
		expect(staleAwareDigestEnabled({ KIMCHI_MEMORY_STALE_AWARE_DIGEST: "false" })).toBe(false)
	})
})
