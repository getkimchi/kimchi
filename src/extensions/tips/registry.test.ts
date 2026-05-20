import { describe, expect, it } from "vitest"
import { TipRegistry } from "./registry.js"

describe("TipRegistry", () => {
	it("registers and unregisters typed providers", () => {
		const registry = new TipRegistry()
		const unregister = registry.registerProvider({
			source: "test.general",
			kind: "general",
			getTips: () => [{ id: "one", message: "Run /help.", command: "/help" }],
		})

		expect(registry.getFirstTip("general")).toEqual({
			source: "test.general",
			kind: "general",
			id: "one",
			message: "Run /help.",
			command: "/help",
		})

		unregister()

		expect(registry.getFirstTip("general")).toBeUndefined()
	})

	it("does not let an older unregister remove a newer provider for the same source", () => {
		const registry = new TipRegistry()
		const unregisterOld = registry.registerProvider({
			source: "test.general",
			kind: "general",
			getTips: () => [{ id: "old", message: "Old tip." }],
		})
		const unregisterNew = registry.registerProvider({
			source: "test.general",
			kind: "general",
			getTips: () => [{ id: "new", message: "New tip." }],
		})

		unregisterOld()

		expect(registry.getFirstTip("general")?.id).toBe("new")

		unregisterNew()

		expect(registry.getFirstTip("general")).toBeUndefined()
	})

	it("skips providers that throw while computing tips", () => {
		const registry = new TipRegistry()
		registry.registerProvider({
			source: "throwing",
			kind: "general",
			getTips: () => {
				throw new Error("provider failed")
			},
		})
		registry.registerProvider({
			source: "valid",
			kind: "general",
			getTips: () => [{ id: "valid", message: "Valid tip." }],
		})

		expect(registry.getFirstTip("general")?.source).toBe("valid")
	})
})
