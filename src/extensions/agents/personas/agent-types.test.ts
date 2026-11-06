import { afterEach, describe, expect, it } from "vitest"
import { BUILTIN_TOOL_NAMES, getConfig, getToolNamesForType, registerAgents } from "./agent-types.js"
import type { AgentConfig } from "./types.js"

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		name: "custom",
		description: "custom",
		extensions: false,
		skills: false,
		systemPrompt: "",
		promptMode: "replace",
		...overrides,
	}
}

describe("agent type tool resolution", () => {
	afterEach(() => {
		registerAgents(new Map())
	})

	it("uses all built-in tools when builtinToolNames is omitted", () => {
		registerAgents(new Map([["DefaultTools", agent({ name: "DefaultTools" })]]))

		expect(getToolNamesForType("DefaultTools")).toEqual(BUILTIN_TOOL_NAMES)
	})

	it("preserves an empty builtinToolNames list as no built-in tools", () => {
		registerAgents(new Map([["NoTools", agent({ name: "NoTools", builtinToolNames: [] })]]))

		expect(getToolNamesForType("NoTools")).toEqual([])
	})

	it("returns no tools for unknown types — fail closed, never General-Purpose's set (issue #1678)", () => {
		expect(getToolNamesForType("does-not-exist")).toEqual([])
	})

	it("returns no tools for disabled types", () => {
		registerAgents(new Map([["Off", agent({ name: "Off", enabled: false })]]))

		expect(getToolNamesForType("Off")).toEqual([])
	})

	it("getConfig falls back to a fail-closed config for unknown types, not General-Purpose (issue #1678)", () => {
		const cfg = getConfig("does-not-exist")

		expect(cfg.builtinToolNames).toEqual([])
		expect(cfg.extensions).toBe(false)
		expect(cfg.skills).toBe(false)
	})

	it("getConfig falls back to a fail-closed config for disabled types", () => {
		registerAgents(new Map([["Off", agent({ name: "Off", enabled: false })]]))

		const cfg = getConfig("Off")
		expect(cfg.builtinToolNames).toEqual([])
		expect(cfg.extensions).toBe(false)
		expect(cfg.skills).toBe(false)
	})
})
