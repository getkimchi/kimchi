import { describe, expect, it } from "vitest"
import { isGrade } from "./judge.js"

describe("isGrade", () => {
	it("accepts the five valid letters", () => {
		for (const g of ["A", "B", "C", "D", "F"]) expect(isGrade(g)).toBe(true)
	})

	it("rejects lowercase, neighbouring letters, numbers, and non-strings", () => {
		for (const x of ["a", "E", "G", "", "AA", 1, null, undefined, {}]) expect(isGrade(x)).toBe(false)
	})
})
