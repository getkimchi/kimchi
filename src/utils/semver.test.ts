import { describe, expect, it } from "vitest"
import { compareSemverGte } from "./semver.js"

describe("compareSemverGte", () => {
	it("returns true for equal versions", () => {
		expect(compareSemverGte("1.14.0", "1.14.0")).toBe(true)
	})

	it("returns true for larger versions", () => {
		expect(compareSemverGte("1.14.1", "1.14.0")).toBe(true)
		expect(compareSemverGte("1.15.0", "1.14.0")).toBe(true)
		expect(compareSemverGte("2.0.0", "1.14.0")).toBe(true)
	})

	it("returns false for smaller versions", () => {
		expect(compareSemverGte("1.13.99", "1.14.0")).toBe(false)
		expect(compareSemverGte("0.99.0", "1.14.0")).toBe(false)
	})

	it("returns false for null/empty/garbage input — falls back to legacy plugin format", () => {
		expect(compareSemverGte(null, "1.14.0")).toBe(false)
		expect(compareSemverGte("", "1.14.0")).toBe(false)
		expect(compareSemverGte("not-a-version", "1.14.0")).toBe(false)
	})

	it("ignores prerelease/build suffixes (matches Go semver.GreaterThan/Equal-on-Major.Minor.Patch)", () => {
		expect(compareSemverGte("1.14.0-beta.1", "1.14.0")).toBe(true)
		expect(compareSemverGte("1.14.0+build.5", "1.14.0")).toBe(true)
	})
})
