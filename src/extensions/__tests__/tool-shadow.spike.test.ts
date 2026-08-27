/**
 * SPIKE (token-optimization initiative, plan Chunk 2): can a kimchi extension
 * register a tool with a core tool's name to override its description/schema?
 *
 * Answer (pinning the observed behavior of the installed upstream dist):
 *   **Shadow, silently.** `AgentSession._refreshToolRegistry` builds the definition
 *   registry from `_baseToolDefinitions` first, then `definitionRegistry.set()`s every
 *   extension-registered / custom tool over it — a custom definition named `bash`
 *   replaces the builtin without warning, error, or dedup. Same for the execution
 *   registry further down (wrappedBuiltInTools first, then wrappedExtensionTools set
 *   over them).
 *
 * Implication for Phase 1 (tool-schema compression): an extension CAN shadow core
 * tool definitions to tighten descriptions. Caveats recorded in
 * `.kimchi/docs/tool-spike-findings.md`.
 *
 * Pattern mirrors upstream-system-prompt-preservation-patch.test.ts: assert the
 * mechanism exists in the installed dist, then drive the real proto method against a
 * minimal fake `this` to prove the merge outcome.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

interface ToolDef {
	name: string
	label: string
	description: string
	parameters: unknown
	execute: (...args: unknown[]) => Promise<unknown>
	promptSnippet?: string
	promptGuidelines?: string[]
}

function fakeTool(name: string, description: string): ToolDef {
	return {
		name,
		label: name,
		description,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [], details: {} }
		},
	}
}

const sessionProto = AgentSession.prototype as unknown as {
	_refreshToolRegistry: (this: unknown, options?: Record<string, unknown>) => void
}

function makeFakeSession(customTools: ToolDef[], baseTools: ToolDef[]) {
	const fake = {
		_customTools: customTools,
		_allowedToolNames: undefined as Set<string> | undefined,
		_excludedToolNames: undefined as Set<string> | undefined,
		_toolRegistry: new Map<string, unknown>(),
		_baseToolDefinitions: new Map(baseTools.map((t) => [t.name, t])),
		_toolDefinitions: new Map<string, unknown>(),
		_toolPromptSnippets: new Map<string, string>(),
		_toolPromptGuidelines: new Map<string, string[]>(),
		activeToolNames: [] as string[],
		_extensionRunner: { getAllRegisteredTools: () => [] },
		getActiveToolNames() {
			return this.activeToolNames
		},
		setActiveToolsByName(names: string[]) {
			this.activeToolNames = [...new Set(names)]
		},
		_normalizePromptSnippet(snippet: string | undefined) {
			return snippet ?? null
		},
		_normalizePromptGuidelines(guidelines: string[] | undefined) {
			return guidelines ?? []
		},
	}
	sessionProto._refreshToolRegistry.call(fake)
	return fake
}

describe("registerTool shadow spike", () => {
	it("the merge mechanism exists in the installed upstream dist", () => {
		const src = String(sessionProto._refreshToolRegistry)
		// Base definitions seed the registry...
		expect(src).toContain("_baseToolDefinitions")
		// ...then custom tools overwrite entries by name.
		expect(src).toContain("definitionRegistry.set(tool.definition.name")
	})

	it("a custom tool with a core tool's name silently shadows the builtin definition", () => {
		const builtin = fakeTool("bash", "BUILTIN description: run commands")
		const shadow = fakeTool("bash", "SHORT: run cmds")

		const fake = makeFakeSession([shadow], [builtin])
		const defined = fake._toolDefinitions.get("bash") as { definition: ToolDef } | undefined
		expect(defined?.definition).toBe(fake._customTools[0])
		expect(defined?.definition.description).toBe("SHORT: run cmds")
	})

	it("the execution registry likewise ends up with the shadow", () => {
		const builtin = fakeTool("bash", "BUILTIN description")
		const shadow = fakeTool("bash", "SHADOW")

		const fake = makeFakeSession([shadow], [builtin])
		const registryEntry = fake._toolRegistry.get("bash") as { name: string; description?: string } | undefined
		expect(registryEntry?.name).toBe("bash")
		expect(registryEntry?.description).toBe("SHADOW")
	})

	it("new tool names are appended without touching built-ins", () => {
		const builtin = fakeTool("bash", "BUILTIN description")
		const custom = fakeTool("my_tool", "custom")

		const fake = makeFakeSession([custom], [builtin])
		expect((fake._toolDefinitions.get("bash") as { definition: ToolDef }).definition.description).toBe(
			"BUILTIN description",
		)
		expect((fake._toolDefinitions.get("my_tool") as { definition: ToolDef }).definition.description).toBe("custom")
	})
})
