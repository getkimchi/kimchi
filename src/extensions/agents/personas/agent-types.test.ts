import { afterEach, describe, expect, it } from "vitest"
import {
	BUILTIN_TOOL_NAMES,
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
