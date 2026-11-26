import { describe, expect, it } from "vitest"
import { isReviewCommandEnabled } from "./index.js"

describe("review command experimental gate", () => {
	it.each([
		{ experimental: false, review: false, print: false, enabled: false },
		{ experimental: false, review: true, print: false, enabled: false },
		{ experimental: true, review: false, print: false, enabled: true },
		{ experimental: true, review: false, print: true, enabled: true },
		{ experimental: false, review: false, print: true, enabled: false },
		{ experimental: false, review: true, print: true, enabled: true },
		{ experimental: true, review: true, print: true, enabled: true },
	])("returns $enabled for experimental=$experimental review=$review print=$print", (options) => {
		expect(isReviewCommandEnabled(options)).toBe(options.enabled)
	})
})
