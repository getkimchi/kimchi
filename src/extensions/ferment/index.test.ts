import { describe, expect, it } from "vitest"

// Inline copy of extractContextualOptions from index.ts (keep in sync)
function extractContextualOptions(text: string): string[] | undefined {
	const trimmed = text.trim()
	if (!trimmed) return undefined

	const lines = trimmed
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)

	const numbered = lines.filter((l) => /^\d+[.)]\s/.test(l))
	if (numbered.length >= 2) {
		return numbered.map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
	}

	const lettered = lines.filter((l) => /^\(?[a-z][.)]\)?\s/.test(l))
	if (lettered.length >= 2) {
		return lettered.map((l) => l.replace(/^\(?[a-z][.)]\)?\s*/, "").trim())
	}

	const bulleted = lines.filter((l) => /^[-*•]\s/.test(l))
	if (bulleted.length >= 2) {
		return bulleted.map((l) => l.replace(/^[-*•]\s*/, "").trim())
	}

	// 4. Inline alternatives with "or" — e.g. "Should we retry, skip, or pause?"
	const qIdx = trimmed.lastIndexOf("?")
	if (qIdx !== -1) {
		const beforeQ = trimmed.slice(0, qIdx)
		const orIdx = beforeQ.lastIndexOf(" or ")
		if (orIdx !== -1) {
			const beforeOr = beforeQ.slice(0, orIdx)
			const afterOr = beforeQ.slice(orIdx + 4)
			const parts = beforeOr
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
			if (parts.length >= 1 && afterOr) {
				// Strip leading filler words (should we / do you want to / etc.) from the first option
				const cleaned = parts.map((p, i) => {
					if (i !== 0) return p
					return p.replace(/^(should we|do you want to|would you like to)\s+/i, "").trim() || p
				})
				return [...cleaned, afterOr.trim()]
			}
		}
	}

	return undefined
}

describe("extractContextualOptions", () => {
	it("extracts numbered options", () => {
		const text = `What should we do?
1) Retry
2) Skip
3) Pause`
		expect(extractContextualOptions(text)).toEqual(["Retry", "Skip", "Pause"])
	})

	it("extracts lettered options", () => {
		const text = `Pick:
(a) Red
(b) Blue`
		expect(extractContextualOptions(text)).toEqual(["Red", "Blue"])
	})

	it("extracts bulleted options", () => {
		const text = `Options:
- Commit
- Test
- Deploy`
		expect(extractContextualOptions(text)).toEqual(["Commit", "Test", "Deploy"])
	})

	it("extracts inline alternatives", () => {
		const text = "Should we retry, skip, or pause?"
		expect(extractContextualOptions(text)).toEqual(["retry", "skip", "pause"])
	})

	it("returns undefined for plain questions", () => {
		expect(extractContextualOptions("Does this plan look right?")).toBeUndefined()
	})

	it("returns undefined for single option", () => {
		expect(extractContextualOptions("1) Only option")).toBeUndefined()
	})
})
