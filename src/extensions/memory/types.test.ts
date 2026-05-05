import { describe, expect, it } from "vitest"
import type { MemoryAction, MemoryTarget } from "./types.js"

describe("MemoryTarget type", () => {
	it("should accept valid targets", () => {
		const t1: MemoryTarget = "memory"
		const t2: MemoryTarget = "user"
		expect(t1).toBe("memory")
		expect(t2).toBe("user")
	})
})

describe("MemoryAction type", () => {
	it("should accept valid actions", () => {
		const a1: MemoryAction = "add"
		const a2: MemoryAction = "replace"
		const a3: MemoryAction = "remove"
		const a4: MemoryAction = "read"
		expect([a1, a2, a3, a4]).toEqual(["add", "replace", "remove", "read"])
	})
})
