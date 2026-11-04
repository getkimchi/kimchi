// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest"
import { deriveDraftFermentTitle, normalizeFermentTitle } from "./title.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("deriveDraftFermentTitle", () => {
	it("derives a deterministic local title without calling fetch", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")

		expect(deriveDraftFermentTitle("  Build   OAuth Login  ")).toBe("Build OAuth Login")

		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("normalizes model-proposed titles", () => {
		expect(normalizeFermentTitle('  "Build   OAuth Login"  ')).toBe("Build OAuth Login")
		expect(normalizeFermentTitle("   ")).toBeUndefined()
		expect(normalizeFermentTitle('""')).toBeUndefined()
	})

	it("truncates long titles at a word boundary", () => {
		const title = normalizeFermentTitle(
			"Build a complete OAuth login and account linking migration with rollout safeguards",
		)

		expect(title).toBe("Build a complete OAuth login and account linking migration")
		expect(title?.length).toBeLessThanOrEqual(60)
	})

	it("falls back for empty draft intents", () => {
		expect(deriveDraftFermentTitle("   ")).toBe("Untitled Ferment")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
