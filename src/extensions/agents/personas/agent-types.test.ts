import { afterEach, describe, expect, it } from "vitest"
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getAllTypes,
	getAvailableTypes,
	getConfig,
	getDefaultAgentNames,
	getToolNamesForType,
	isValidType,
	registerAgents,
} from "./agent-types.js"
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

	it("General-Purpose declares its full builtin tool set explicitly — no implicit widening for personas that omit builtinToolNames", () => {
		registerAgents(new Map())

		expect(getAgentConfig("General-Purpose")?.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES)
		expect(getToolNamesForType("General-Purpose")).toEqual(BUILTIN_TOOL_NAMES)
	})
})

describe("advertised default agents", () => {
	afterEach(() => {
		registerAgents(new Map())
	})

	it("never lists the host-only Ferment V2 personas", () => {
		registerAgents(new Map([["Mine", agent({ name: "Mine" })]]))
		const names = getDefaultAgentNames()
		expect(names).toContain("Explore")
		for (const hidden of ["Verifier"]) expect(names).not.toContain(hidden)
		expect(names).not.toContain("Mine")
		expect(getAllTypes()).not.toContain("Verifier")
		expect(getAvailableTypes()).not.toContain("Verifier")
		expect(isValidType("Verifier")).toBe(false)
	})

	it("uses the host-only Verifier runtime profile instead of General Purpose", () => {
		registerAgents(new Map())

		expect(getConfig("Verifier")).toMatchObject({
			displayName: "Verifier",
			extensions: false,
			skills: false,
			promptMode: "replace",
		})
		expect(getToolNamesForType("Verifier")).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"write",
			"report_finding",
			"retract_finding",
			"resolve_finding",
			"submit_verdict",
		])
	})
})
