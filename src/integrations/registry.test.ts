// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _resetRegistryForTests, all, byId, register } from "./registry.js"
import type { ToolDefinition } from "./types.js"

function fakeTool(id: ToolDefinition["id"], overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		id,
		name: id,
		description: "fake",
		configPath: "~/fake",
		binaryName: id,
		isInstalled: () => false,
		write: async () => {},
		...overrides,
	}
}

describe("integrations/registry", () => {
	beforeEach(() => _resetRegistryForTests())
	afterEach(() => _resetRegistryForTests())

	it("starts empty", () => {
		expect(all()).toEqual([])
		expect(byId("opencode")).toBeUndefined()
	})

	it("returns tools in registration order", () => {
		register(fakeTool("opencode"))
		register(fakeTool("claudecode"))
		expect(all().map((t) => t.id)).toEqual(["opencode", "claudecode"])
	})

	it("byId returns the registered tool", () => {
		const t = fakeTool("cursor")
		register(t)
		expect(byId("cursor")).toBe(t)
	})

	it("rejects duplicate registration to surface accidental double-imports", () => {
		register(fakeTool("opencode"))
		expect(() => register(fakeTool("opencode"))).toThrow(/already registered/)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
