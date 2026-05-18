import { afterEach, describe, expect, it } from "vitest"
import { BUILTIN_TOOL_NAMES, getToolNamesForType, registerAgents } from "./agent-types.js"
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
