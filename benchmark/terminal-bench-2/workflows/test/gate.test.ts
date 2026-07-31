import { describe, expect, it } from "vitest"
import { gradeRefuses, MAX_BLOCK_RETRIES, minimumAcceptableGrade } from "./ferment/contract.ts"

describe("gradeRefuses", () => {
	it("refuses a missing grade instead of accepting it", () => {
		expect(gradeRefuses(undefined, 0)).toBe(true)
		expect(gradeRefuses(undefined, 1)).toBe(true)
	})
	it("still applies the letter bar it always did", () => {
		expect(minimumAcceptableGrade(0)).toBe("A")
		expect(gradeRefuses("A", 0)).toBe(false)
		expect(gradeRefuses("B", 0)).toBe(true)
		expect(gradeRefuses("B", 1)).toBe(false)
		expect(gradeRefuses("C", 1)).toBe(true)
	})
	it("treats an unrecognised grade as below the bar", () => {
		expect(gradeRefuses("Z", 0)).toBe(true)
	})
	it("bounds the cost: a refusal is accepted once the retry budget is spent", () => {
		expect(MAX_BLOCK_RETRIES).toBe(3)
	})
})
