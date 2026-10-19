import { describe, expect, it } from "vitest"
import { DEFAULT_MAX_FILE_MB, MAX_FILE_MB_ENV, maxFileBytes } from "./limits.js"

describe("maxFileBytes", () => {
	it("defaults to 20 MB", () => {
		expect(maxFileBytes({})).toBe(DEFAULT_MAX_FILE_MB * 1024 * 1024)
	})
	it("honors the override env var", () => {
		expect(maxFileBytes({ [MAX_FILE_MB_ENV]: "50" })).toBe(50 * 1024 * 1024)
	})
	it("ignores invalid override values", () => {
		expect(maxFileBytes({ [MAX_FILE_MB_ENV]: "nope" })).toBe(DEFAULT_MAX_FILE_MB * 1024 * 1024)
		expect(maxFileBytes({ [MAX_FILE_MB_ENV]: "-5" })).toBe(DEFAULT_MAX_FILE_MB * 1024 * 1024)
	})
})
