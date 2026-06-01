import { describe, expect, it } from "vitest"
import { truncatePath } from "./logo-art.js"

describe("truncatePath", () => {
	it("returns short paths unchanged", () => {
		expect(truncatePath("~/project", 20)).toBe("~/project")
		expect(truncatePath("/home/user/foo", 20)).toBe("/home/user/foo")
	})

	it("truncates from the right when there is no slash", () => {
		expect(truncatePath("someverylongname", 10)).toBe("somever...")
		expect(truncatePath("someverylongname", 5)).toBe("so...")
	})

	it("preserves the basename with ellipsis in the directory part", () => {
		expect(truncatePath("/home/user/cast/kimchi", 14)).toBe("/hom.../kimchi")
	})

	it("preserves the tilde prefix and basename", () => {
		expect(truncatePath("~/very/long/path/kimchi", 16)).toBe("~/very.../kimchi")
	})

	it("preserves an absolute root path prefix", () => {
		expect(truncatePath("/very/long/path/to/kimchi", 16)).toBe("/very/.../kimchi")
	})

	it("falls back to right truncation when even the minimal prefix does not fit", () => {
		expect(truncatePath("/home/user/cast/kimchi", 5)).toBe("/h...")
	})
})
