import { describe, expect, it } from "vitest"
import { extractContextualOptions } from "./contextual-options.js"

describe("extractContextualOptions", () => {
	it("extracts numbered options from the final question block", () => {
		const text = `What should we do?
1) Retry
2) Skip
3) Pause`
		expect(extractContextualOptions(text)).toEqual(["Retry", "Skip", "Pause"])
	})

	it("extracts lettered options", () => {
		const text = `Pick?
(a) Red
(b) Blue`
		expect(extractContextualOptions(text)).toEqual(["Red", "Blue"])
	})

	it("extracts bulleted options", () => {
		const text = `Options?
- Commit
- Test
- Deploy`
		expect(extractContextualOptions(text)).toEqual(["Commit", "Test", "Deploy"])
	})

	it("ignores inline alternatives", () => {
		const text = "Should we retry, skip, or pause?"
		expect(extractContextualOptions(text)).toBeUndefined()
	})

	it("ignores ambiguous inline alternatives with trailing question framing", () => {
		const text = "The plan covers Phase A, Phase B, or Phase C — which interests you?"
		expect(extractContextualOptions(text)).toBeUndefined()
	})

	it("ignores numbered plan content before a binary confirmation question", () => {
		const text = `Plan:
1) Implement parser
2) Add tests

Does this plan look right?`
		expect(extractContextualOptions(text)).toBeUndefined()
	})

	it("ignores informational bullets directly before a non-whitelisted question", () => {
		const text = `Heads up before we continue:
- The result will be merged
- It cannot be undone
Continue?`
		expect(extractContextualOptions(text)).toBeUndefined()
	})

	it("ignores numbered plan content directly before a non-whitelisted question", () => {
		const text = `Plan:
1) Implement parser
2) Add tests
Proceed?`
		expect(extractContextualOptions(text)).toBeUndefined()
	})

	it("returns undefined for plain questions", () => {
		expect(extractContextualOptions("Does this plan look right?")).toBeUndefined()
	})

	it("returns undefined for single option", () => {
		expect(extractContextualOptions("1) Only option")).toBeUndefined()
	})
})
