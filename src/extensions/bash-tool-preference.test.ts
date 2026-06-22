/**
 * Unit tests for the bash-tool-preference extension.
 *
 * The test harness uses a minimal mock of `ExtensionAPI` that records
 * registered handlers, so we can fire `session_start` events and assert
 * on the mutation the extension performs.
 */
import { describe, expect, it } from "vitest"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PI = import("@earendil-works/pi-coding-agent").ExtensionAPI

interface MockPI {
	handlers: Record<string, Array<(event: unknown) => unknown>>
	on(event: string, handler: (event: unknown) => unknown): void
	// getAllTools is called on session_start. The mock returns whatever
	// the test sets via setTools().
	_tools: Array<{ name: string; description: string }>
	setTools(tools: Array<{ name: string; description: string }>): void
	getAllTools(): Array<{ name: string; description: string }>
}

function createMockPI(): MockPI {
	const handlers: MockPI["handlers"] = {}
	const self: MockPI = {
		handlers,
		_tools: [],
		setTools(tools) {
			this._tools = tools
		},
		getAllTools() {
			return this._tools
		},
		on(event, handler) {
			if (!handlers[event]) handlers[event] = []
			handlers[event].push(handler)
		},
	}
	return self
}

function fireSessionStart(pi: MockPI): void {
	const handlers = pi.handlers.session_start ?? []
	for (const handler of handlers) handler({})
}

import bashToolPreferenceExtension, {
	applyDescriptionOverride,
	BASH_TOOL_DESCRIPTION,
	TOOL_PREFERENCES_BLOCK,
	toolDescriptionOverride,
} from "./bash-tool-preference.js"

describe("TOOL_PREFERENCES_BLOCK", () => {
	it("contains the section header", () => {
		expect(TOOL_PREFERENCES_BLOCK).toContain("## Tool Preferences")
	})

	it("maps each file operation to its dedicated tool", () => {
		// Each line should pair the file operation with the dedicated
		// tool name in backticks. Verifying the mapping catches
		// accidental edits that drop the substitution targets.
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `read`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `edit`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `write`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `grep`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `find`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `ls`")
	})

	it("lists the anti-patterns being discouraged", () => {
		// Spot-check the most common anti-patterns so we know the
		// guidance covers the cases bash-tool-guard steers on.
		expect(TOOL_PREFERENCES_BLOCK).toContain("cat")
		expect(TOOL_PREFERENCES_BLOCK).toContain("head")
		expect(TOOL_PREFERENCES_BLOCK).toContain("tail")
		expect(TOOL_PREFERENCES_BLOCK).toContain("sed -i")
	})

	it("specifies what bash IS for", () => {
		expect(TOOL_PREFERENCES_BLOCK).toMatch(/build|test|git|package/i)
	})
})

describe("BASH_TOOL_DESCRIPTION", () => {
	it("describes what bash is for", () => {
		expect(BASH_TOOL_DESCRIPTION).toMatch(/build|test|git|package/i)
	})

	it("explicitly tells the model to use dedicated tools for file ops", () => {
		expect(BASH_TOOL_DESCRIPTION).toContain("use `read`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `edit`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `write`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `grep`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `find`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `ls`")
	})

	it("preserves the upstream truncation behaviour", () => {
		// The output truncation contract is important — dropping it would
		// change runtime semantics. Verify the truncation info survives.
		expect(BASH_TOOL_DESCRIPTION).toMatch(/truncat/i)
	})
})

describe("toolDescriptionOverride", () => {
	it("returns the override for the bash tool", () => {
		expect(toolDescriptionOverride("bash")).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("returns undefined for non-bash tools", () => {
		expect(toolDescriptionOverride("read")).toBeUndefined()
		expect(toolDescriptionOverride("edit")).toBeUndefined()
		expect(toolDescriptionOverride("grep")).toBeUndefined()
		expect(toolDescriptionOverride("Agent")).toBeUndefined()
		expect(toolDescriptionOverride("")).toBeUndefined()
	})
})

describe("applyDescriptionOverride", () => {
	it("overrides the description for bash", () => {
		const tool = { name: "bash", description: "old description" }
		const result = applyDescriptionOverride(tool)
		expect(result.description).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("does not mutate the input object", () => {
		// The pure helper must return a new object for non-bash tools
		// too — callers depend on immutability.
		const tool = { name: "read", description: "unchanged" }
		const result = applyDescriptionOverride(tool)
		expect(result).not.toBe(tool)
		expect(result.description).toBe("unchanged")
	})

	it("passes through non-bash tools with the same description", () => {
		const tool = { name: "read", description: "Read file contents" }
		const result = applyDescriptionOverride(tool)
		expect(result.description).toBe("Read file contents")
	})
})

describe("bashToolPreferenceExtension", () => {
	it("registers a session_start handler", () => {
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)
		expect(pi.handlers.session_start).toBeDefined()
		// The extension's own handler runs in addition to the one
		// createSystemPromptBlocks registers internally for session
		// tracking. We only assert that at least one is registered.
		expect(pi.handlers.session_start.length).toBeGreaterThanOrEqual(1)
	})

	it("mutates the bash tool description on session_start", () => {
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)

		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute bash commands (ls, grep, find, etc.)" },
			{ name: "edit", description: "Edit a file" },
		]
		pi.setTools(tools)

		fireSessionStart(pi)

		expect(tools[1].description).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("does not mutate non-bash tools", () => {
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)

		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "edit", description: "Edit a file" },
			{ name: "grep", description: "Search file contents" },
		]
		pi.setTools(tools)

		fireSessionStart(pi)

		// All non-bash tools should be byte-for-byte unchanged.
		expect(tools[0].description).toBe("Read file contents")
		expect(tools[1].description).toBe("Edit a file")
		expect(tools[2].description).toBe("Search file contents")
	})

	it("is safe when no bash tool is registered", () => {
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)

		// Tools list without bash — should not throw.
		pi.setTools([{ name: "read", description: "Read file contents" }])

		expect(() => fireSessionStart(pi)).not.toThrow()
	})

	it("is safe when the tool list is empty", () => {
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)
		pi.setTools([])
		expect(() => fireSessionStart(pi)).not.toThrow()
	})

	it("mutates the actual tool object (not a copy) so downstream reads see the change", () => {
		// The kimchi prompt-enrichment handler reads pi.getAllTools() and
		// passes the same object references to buildSystemPrompt. If the
		// extension returns a new object, the mutation never reaches the
		// prompt. Guard against accidental reassignment.
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)
		const bashTool = { name: "bash", description: "old" }
		pi.setTools([bashTool])

		fireSessionStart(pi)

		// pi.getAllTools() must return the same mutated object.
		expect(pi.getAllTools()[0]).toBe(bashTool)
		expect(bashTool.description).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("registers a system prompt block via createSystemPromptBlocks", () => {
		// Smoke test: after registering, the extension must run cleanly on
		// session_start. The actual block registration is exercised by the
		// shared createSystemPromptBlocks infrastructure, which has its
		// own tests in system-prompt-blocks.test.ts.
		const pi = createMockPI()
		bashToolPreferenceExtension(pi as unknown as PI)
		expect(() => fireSessionStart(pi)).not.toThrow()
	})
})
