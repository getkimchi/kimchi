import { describe, expect, it } from "vitest"
import { truncate } from "./prompts.js"

describe("truncate helper", () => {
	it("returns original string if under max length", () => {
		expect(truncate("short", 10)).toBe("short")
	})

	it("truncates strings exceeding max length", () => {
		expect(truncate("hello world", 5)).toBe("hell…")
	})

	it("handles exact length strings", () => {
		expect(truncate("hello", 5)).toBe("hello")
	})
})
