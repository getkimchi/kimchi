/**
 * Integration tests for the bashToolGuardExtension wiring.
 * Tests the event handler registration (session_start, input, tool_call)
 * using a mock ExtensionAPI.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { BASH_TOOL_GUARD_EVENTS } from "./bash-tool-guard-events.js"
import bashToolGuardExtension, { STEER_MESSAGE_TYPE } from "./bash-tool-guard.js"

let mockMode: string | undefined = "default"
let mockResourceEnabled = true

vi.mock("./permissions/mode-controller.js", () => ({
	getPermissionMode: () => (mockMode ? { mode: mockMode, source: "user" } : undefined),
}))

vi.mock("../resources/store.js", () => ({
	isResourceEnabled: (id: string) => (id === "extensions.bash-tool-guard" ? mockResourceEnabled : true),
}))

afterEach(() => {
	mockMode = "default"
	mockResourceEnabled = true
})

interface BlockResult {
	block: true
	reason: string
}

interface MockExtensionAPI {
	handlers: Record<string, Array<(...args: unknown[]) => unknown>>
	on: (event: string, handler: (...args: unknown[]) => unknown) => void
	sendMessage: ReturnType<typeof vi.fn>
	events: { emit: ReturnType<typeof vi.fn> }
	_blockResult?: BlockResult
	_emittedEvents: Array<{ channel: string; payload: unknown }>
	/** getAllTools() returns the live bash tool list. The integration tests
	 *  don't exercise the preference description override, so the default
	 *  empty array is fine — the session_start hook only needs the call to
	 *  not throw. Override via `setTools()` for tests that need a specific
	 *  tool list. */
	getAllTools: () => Array<{ name: string; description: string }>
	setTools: (tools: Array<{ name: string; description: string }>) => void
}

function createMockPI(): MockExtensionAPI {
	const handlers: MockExtensionAPI["handlers"] = {}
	const _emittedEvents: MockExtensionAPI["_emittedEvents"] = []
	let tools: Array<{ name: string; description: string }> = []
	return {
		handlers,
		on(event: string, handler) {
			if (!handlers[event]) handlers[event] = []
			handlers[event].push(handler)
		},
		sendMessage: vi.fn(),
		events: {
			emit: vi.fn((channel: string, payload: unknown) => {
				_emittedEvents.push({ channel, payload })
			}),
		},
		_emittedEvents,
		getAllTools() {
			return tools
		},
		setTools(t) {
			tools = t
		},
	}
}

function emit(pi: MockExtensionAPI, event: string, payload: Record<string, unknown> = {}): BlockResult | undefined {
	const handlers = pi.handlers[event] ?? []
	let blockResult: BlockResult | undefined
	for (const h of handlers) {
		const result = h(payload) as BlockResult | undefined
		if (result?.block) {
			blockResult = result
			pi._blockResult = result
		}
	}
	return blockResult
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PI = import("@earendil-works/pi-coding-agent").ExtensionAPI

function fakeCtx(sessionId = "test-session"): { sessionManager: { getSessionId: () => string } } {
	return { sessionManager: { getSessionId: () => sessionId } }
}

function fireSessionStart(pi: MockExtensionAPI): void {
	const handlers = pi.handlers.session_start ?? []
	for (const h of handlers) h({}, fakeCtx())
}

describe("bashToolGuardExtension wiring", () => {
	it("registers session_start, input, and tool_call handlers", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		expect(pi.handlers.session_start?.length).toBeGreaterThan(0)
		expect(pi.handlers.input?.length).toBeGreaterThan(0)
		expect(pi.handlers.tool_call?.length).toBeGreaterThan(0)
	})

	it("first matching bash call steers, doesn't block", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		expect(result).toBeUndefined()
		expect(pi._blockResult).toBeUndefined()
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
	})

	it("second matching bash call blocks", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		const result = emit(pi, "tool_call", { toolName: "bash", input: { command: "head b.ts" } })
		expect(result?.block).toBe(true)
		expect(result?.reason).toMatch(/read/i)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1) // still only the one steer
	})

	it("different categories have independent budgets", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// First read → steer
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		// First edit → steer (different category)
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' a.ts" },
		})
		// First write → steer (different category)
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "echo 'x' > a.ts" },
		})
		expect(pi.sendMessage).toHaveBeenCalledTimes(3)
		expect(pi._blockResult).toBeUndefined()
	})

	it("session_start resets counters", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } }) // would block
		expect(pi._blockResult?.block).toBe(true)

		// Reset and re-test
		fireSessionStart(pi)
		pi._blockResult = undefined
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat c.ts" },
		})
		expect(result).toBeUndefined()
		expect(pi._blockResult).toBeUndefined()
	})

	it("user `input` event resets counters (extension source does not)", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } }) // would block

		// User input resets counters
		emit(pi, "input", { source: "interactive" })
		pi._blockResult = undefined

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat c.ts" },
		})
		expect(result).toBeUndefined()
	})

	it("extension-source input does NOT reset counters", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } }) // would block

		// Extension-sourced input must not reset
		emit(pi, "input", { source: "extension" })
		pi._blockResult = undefined

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat c.ts" },
		})
		expect(result?.block).toBe(true)
	})

	it("non-bash tool calls are ignored", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "read", input: { filePath: "foo.ts" } })
		emit(pi, "tool_call", { toolName: "edit", input: { filePath: "foo.ts" } })
		emit(pi, "tool_call", { toolName: "write", input: { filePath: "foo.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
	})

	it("legitimate bash calls are not flagged", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const legitCommands = [
			"git status",
			"pnpm test",
			"pnpm run build",
			"ls -la",
			"grep -r 'TODO' src/",
			"rg 'foo' src/",
			"echo 'build done'", // no redirect
			"echo 'log' > /dev/null", // stream target
		]
		for (const command of legitCommands) {
			const result = emit(pi, "tool_call", { toolName: "bash", input: { command } })
			expect(result).toBeUndefined()
		}
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
	})

	it("plan-mode permission context disables the guard", () => {
		mockMode = "plan"
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// Even repeated anti-patterns should pass under plan mode.
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat c.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
	})

	it("caller-supplied isEnabled=false disables the guard", () => {
		// Regression: previously the extension factory hardcoded its own
		// isEnabled predicate, silently ignoring any caller-supplied one.
		mockMode = "default"
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { isEnabled: () => false })
		fireSessionStart(pi)

		// Anti-patterns pass without warn/block/steer events.
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
		expect(pi._emittedEvents).toHaveLength(0)
	})

	it("caller-supplied isEnabled=true is overridden by plan mode", () => {
		// Plan mode is inspection-only and must take precedence over a
		// permissive caller predicate.
		mockMode = "plan"
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { isEnabled: () => true })
		fireSessionStart(pi)

		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
	})

	it("caller-supplied isEnabled=true permits guard outside plan mode", () => {
		// Sanity check: a permissive caller predicate lets the guard run.
		mockMode = "default"
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, {
			isEnabled: () => true,
			blockOnThreshold: true,
		})
		fireSessionStart(pi)

		// First `cat` warns (steer message), second blocks.
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const result = emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		expect(result?.block).toBe(true)
	})

	it("dynamically skips tool_call when resource is disabled at runtime", () => {
		// The /resources toggle should take effect mid-session without
		// a restart. The tool_call handler consults isResourceEnabled
		// on every bash call.
		mockMode = "default"
		mockResourceEnabled = false
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// Resource disabled → guard stays silent even on repeated
		// anti-patterns that would otherwise exceed the threshold.
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat c.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()
		expect(pi._emittedEvents).toHaveLength(0)

		// Re-enabling the resource mid-session restores the guard.
		mockResourceEnabled = true
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const result = emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		expect(result?.block).toBe(true)
	})

	it("block reason text names the better tool", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' a.ts" },
		}) // warn
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/x/y/' a.ts" },
		}) // block
		expect(result?.reason).toMatch(/edit tool/)
	})

	it("non-string command input is ignored", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: 42 },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("empty command is ignored", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "" },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("missing toolName is ignored", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", { input: { command: "cat foo.ts" } })
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("user prompt mentioning the tool bypasses the guard", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// User explicitly asks: "please use sed to fix foo.ts"
		emit(pi, "input", { source: "interactive", text: "please use sed to fix foo.ts" })

		// Model runs sed twice — would normally steer then block.
		const r1 = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' foo.ts" },
		})
		expect(r1).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()

		const r2 = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/c/d/' foo.ts" },
		})
		expect(r2).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("explicit-request override is per-tool (cat allowed, sed still guarded)", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "use cat to read foo.ts" })

		// cat: allowed (user mentioned)
		const r1 = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		expect(r1).toBeUndefined()

		// sed: not mentioned, still guarded
		const r2 = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' foo.ts" },
		})
		expect(r2).toBeUndefined() // first match: warn, not block
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("substring false-positive guard: 'categorize' does not bypass cat block", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// 'cat' inside 'categorize' — word-boundary match means this should NOT bypass.
		emit(pi, "input", { source: "interactive", text: "categorize the files" })

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		expect(result).toBeUndefined() // first: steer
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("next user input overrides the previous prompt (no stale override)", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// First prompt explicitly asks for sed → allowed
		emit(pi, "input", { source: "interactive", text: "use sed to fix foo.ts" })
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' foo.ts" },
		})
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// Next user prompt doesn't mention sed AND has no edit intent
		// (avoid "edit bar.ts" which now matches the edit semantic pattern).
		emit(pi, "input", { source: "interactive", text: "now look at bar.ts" })
		const r = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/x/y/' bar.ts" },
		})
		expect(r).toBeUndefined() // first match: steer
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})
})

describe("bashToolGuardExtension — compound commands", () => {
	it("flags read in compound (cat foo && echo done)", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts && echo done" },
		})
		expect(result).toBeUndefined() // first match: warn
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: STEER_MESSAGE_TYPE,
				content: expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringMatching(/read/i) }),
				]),
			}),
			{ deliverAs: "steer" },
		)
	})

	it("flags write in compound (git status; echo x > foo)", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "git status; echo 'x' > foo.ts" },
		})
		expect(result).toBeUndefined() // warn
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("blocks write in compound on second match", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "git status; echo 'first' > a.ts" },
		}) // warn
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "git pull && echo 'done' > progress.txt" },
		}) // block
		expect(result?.block).toBe(true)
		expect(result?.reason).toMatch(/write/i)
	})

	it("allows compound read when user explicitly asks", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "cat foo.ts and bar.ts" })
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts && cat bar.ts" },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("flags pipe where first segment is a read", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts | head -n 5" },
		})
		expect(result).toBeUndefined() // warn
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})
})

describe("bashToolGuardExtension — semantic intent override", () => {
	it("'read the file' intent allows cat through the full extension", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "read the file foo.ts and summarize" })
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("'fix the typo' intent allows sed through the full extension", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "fix the typo in foo.ts" })
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/typo/fix/' foo.ts" },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("'write to file' intent allows echo redirect through the full extension", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "write the result to output.txt" })
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "echo 'done' > output.txt" },
		})
		expect(result).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("semantic intent for one category does NOT bypass other categories", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		// 'read the file' → read semantic intent active
		emit(pi, "input", { source: "interactive", text: "read the file foo.ts" })
		// cat allowed
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// but write/edit still guarded (no intent match)
		const result = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' foo.ts" },
		})
		expect(result).toBeUndefined() // warn
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})
})

describe("bashToolGuardExtension — telemetry events via pi.events", () => {
	it("emits warn event when first category match fires", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})

		expect(pi.events.emit).toHaveBeenCalledWith(
			BASH_TOOL_GUARD_EVENTS.WARN,
			expect.objectContaining({
				category: "read",
				tool: "cat",
				count: 1,
			}),
		)
	})

	it("emits block event when threshold exceeded", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat a.ts" },
		}) // warn (no block event)
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat b.ts" },
		}) // block

		expect(pi.events.emit).toHaveBeenCalledWith(
			BASH_TOOL_GUARD_EVENTS.BLOCK,
			expect.objectContaining({
				category: "read",
				count: 2,
			}),
		)
	})

	it("emits allow-by-user-request event when explicit override fires", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "please use sed to fix foo.ts" })
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' foo.ts" },
		})

		expect(pi.events.emit).toHaveBeenCalledWith(
			BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST,
			expect.objectContaining({
				category: "edit",
				tool: "sed",
			}),
		)
	})

	it("emits semantic intent allow-by-user-request event", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "input", { source: "interactive", text: "read the file foo.ts" })
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})

		expect(pi.events.emit).toHaveBeenCalledWith(
			BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST,
			expect.objectContaining({
				category: "read",
				tool: "cat",
			}),
		)
	})

	it("does NOT emit events for non-matching bash", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "git status" },
		})

		expect(pi.events.emit).not.toHaveBeenCalled()
	})

	it("does NOT emit events when guard is disabled (plan mode)", () => {
		mockMode = "plan"
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, { blockOnThreshold: true })
		fireSessionStart(pi)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat foo.ts" },
		})
		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "cat bar.ts" },
		})

		expect(pi.events.emit).not.toHaveBeenCalled()
	})
})

describe("bashToolGuardExtension — per-category thresholds", () => {
	it("respects per-category warnThresholds passed via options", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as PI, {
			warnThresholds: { read: 3, edit: 0, write: 1 },
			blockOnThreshold: true,
		})
		fireSessionStart(pi)

		// read budget = 3 → three warns, then block
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat a.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat b.ts" } })
		emit(pi, "tool_call", { toolName: "bash", input: { command: "cat c.ts" } })
		expect(pi._blockResult).toBeUndefined()

		const r4 = emit(pi, "tool_call", { toolName: "bash", input: { command: "cat d.ts" } })
		expect(r4?.block).toBe(true)

		// edit budget = 0 → first occurrence blocks immediately
		pi._blockResult = undefined
		const rEdit = emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "sed -i 's/a/b/' a.ts" },
		})
		expect(rEdit?.block).toBe(true)
	})
})
