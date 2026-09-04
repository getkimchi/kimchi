// extensions/dap/dap-entry.test.ts
//
// Verifies the DAP extension entry point (src/extensions/dap.ts):
//   - session_start detects adapters and sets the status footer
//     (`DAP: <names>` / `DAP: <names> not installed` / partial)
//   - session_shutdown calls clearAllSessions + shutdownAll and clears footer
//   - before_agent_start fires a one-time degraded warning when adapters missing
//   - system prompt block renders `## Debugger (DAP)` only when adapters active
//   - Layer 1 tools are registered on session_start
//
// We mock ./dap/adapters.js and ./dap/client.js so no subprocesses are spawned.
// The extension factory (default export) is called with a mock ExtensionAPI that
// captures `on` handlers, `registerTool` calls, and `setStatus`/`notify` calls.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DapAdapterConfig } from "./types.js"

// =============================================================================
// Mock adapter registry — controlled from tests via setAdapters()
// =============================================================================

const adapterState = vi.hoisted(() => ({
	active: [] as DapAdapterConfig[],
	missing: [] as DapAdapterConfig[],
}))

vi.mock("./adapters.js", () => ({
	detectAdapters: vi.fn(() => adapterState.active),
	detectMissingAdapters: vi.fn(() => adapterState.missing),
	adapterForFile: vi.fn(() => adapterState.active[0] ?? null),
	adapterForDirectory: vi.fn(() => null),
	adapterExists: vi.fn(() => true),
	allAdapters: vi.fn(() => adapterState.active),
}))

// =============================================================================
// Mock DAP client — no subprocess; shutdownAll/clearAllSessions are stubs
// =============================================================================

const clientState = vi.hoisted(() => ({
	shutdownAllCalled: false,
	clearAllCalled: false,
	registeredTools: [] as string[],
	toolObjects: new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>(),
	// sessionAfterCreate lets a test substitute the object sessionRegistry
	// .create returns — e.g. a session whose launch rejects.
	sessionAfterCreate: undefined as
		| { id: string; launch: () => Promise<void>; terminate: () => Promise<void> }
		| undefined,
	removedSessionId: undefined as string | undefined,
}))

vi.mock("./client.js", () => ({
	DapClientRegistry: vi.fn().mockImplementation(() => ({
		getOrCreate: vi.fn(async () => ({}) as unknown),
		shutdownAll: vi.fn(() => {
			clientState.shutdownAllCalled = true
		}),
		getAll: vi.fn(() => []),
	})),
}))

vi.mock("./session.js", () => ({
	DapSessionRegistry: vi.fn().mockImplementation(() => ({
		create: vi.fn(() => clientState.sessionAfterCreate ?? { id: "test-session" }),
		get: vi.fn(() => undefined),
		remove: vi.fn((id: string) => {
			clientState.removedSessionId = id
		}),
		clearAll: vi.fn(() => {
			clientState.clearAllCalled = true
		}),
		getActive: vi.fn(() => []),
	})),
}))

// Capture the createSystemPromptBlocks registration so we can invoke render().
const promptBlocks = vi.hoisted(() => ({
	blocks: [] as Array<{ id: string; render: () => string | undefined }>,
}))

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: () => ({
		register: (block: { id: string; render: () => string | undefined }) => {
			promptBlocks.blocks.push(block)
		},
	}),
}))

// Helper: render all blocks and concatenate non-undefined results
function renderAllPromptBlocks(): string | undefined {
	const parts = promptBlocks.blocks.map((b) => b.render()).filter((s): s is string => s !== undefined)
	if (parts.length === 0) return undefined
	return parts.join("\n\n")
}

// Mock getCurrentPhase so we can control the phase per test for visibility checks.
const phaseState = vi.hoisted(() => ({
	current: undefined as string | undefined,
}))

vi.mock("../tags.js", () => ({
	getCurrentPhase: vi.fn(() => phaseState.current),
}))

// Import the default export AFTER mocks are set up.
const dapExtension = (await import("../dap.js")).default

// =============================================================================
// Mock ExtensionAPI — captures event handlers and tool registrations
// =============================================================================

interface CapturedHandlers {
	session_start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | null
	session_shutdown: (() => Promise<void>) | null
	before_agent_start: (() => Promise<void>) | null
	tool_call: ((event: { toolName: string }, ctx: ExtensionContext) => unknown) | null
}

function createMockPi(): { pi: ExtensionAPI; handlers: CapturedHandlers; activeTools: Set<string> } {
	const activeTools = new Set<string>(["bash", "read", "edit"])
	const handlers: CapturedHandlers = {
		session_start: null,
		session_shutdown: null,
		before_agent_start: null,
		tool_call: null,
	}

	const pi = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "session_start") handlers.session_start = handler as never
			if (event === "session_shutdown") handlers.session_shutdown = handler as never
			if (event === "before_agent_start") handlers.before_agent_start = handler as never
			if (event === "tool_call") handlers.tool_call = handler as never
		}),
		registerTool: vi.fn((tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			clientState.registeredTools.push(tool.name)
			clientState.toolObjects.set(tool.name, tool)
			activeTools.add(tool.name)
		}),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((tools: string[]) => {
			activeTools.clear()
			for (const t of tools) activeTools.add(t)
		}),
	} as unknown as ExtensionAPI

	return { pi, handlers, activeTools }
}

function createCtx(overrides?: Partial<ExtensionContext> & { ui?: Partial<ExtensionUIContext> }): ExtensionContext {
	const statusSet = vi.fn()
	return {
		cwd: "/tmp/test",
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus: statusSet,
			notify: vi.fn(),
			...overrides?.ui,
		} as unknown as ExtensionUIContext,
		sessionManager: {
			getSessionId: () => "test-session-id",
		} as unknown as ExtensionContext["sessionManager"],
		...overrides,
	} as unknown as ExtensionContext
}

// =============================================================================
// Test fixtures
// =============================================================================

const JS_DEBUG: DapAdapterConfig = {
	name: "js-debug",
	command: "js-debug-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

const DLV: DapAdapterConfig = {
	name: "dlv",
	command: "dlv",
	args: ["dap"],
	languages: ["go"],
	extensions: [".go"],
	launchType: "go",
}

const DEBUGPY: DapAdapterConfig = {
	name: "debugpy",
	command: "debugpy",
	args: [],
	languages: ["python"],
	extensions: [".py"],
	launchType: "python",
}

// =============================================================================
// Tests
// =============================================================================

describe("DAP extension entry point", () => {
	let mock: ReturnType<typeof createMockPi>

	beforeEach(() => {
		mock = createMockPi()
		adapterState.active = []
		adapterState.missing = []
		clientState.shutdownAllCalled = false
		clientState.clearAllCalled = false
		clientState.registeredTools = []
		clientState.toolObjects = new Map()
		clientState.sessionAfterCreate = undefined
		clientState.removedSessionId = undefined
		phaseState.current = undefined
		promptBlocks.blocks = []
		dapExtension(mock.pi)
	})

	describe("session_start — status footer", () => {
		it("sets 'DAP: <names>' when adapters are detected", async () => {
			adapterState.active = [JS_DEBUG, DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(ctx.ui?.setStatus).toHaveBeenCalledWith("dap", "DAP: js-debug, dlv")
		})

		it("sets 'DAP: <names> not installed' when language markers present but binaries absent", async () => {
			adapterState.missing = [DEBUGPY]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(ctx.ui?.setStatus).toHaveBeenCalledWith("dap", "DAP: debugpy not installed")
		})

		it("sets partial status when some adapters active and some missing", async () => {
			adapterState.active = [JS_DEBUG]
			adapterState.missing = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(ctx.ui?.setStatus).toHaveBeenCalledWith("dap", "DAP: js-debug · dlv not installed")
		})

		it("clears the footer when no adapters and no missing", async () => {
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(ctx.ui?.setStatus).toHaveBeenCalledWith("dap", undefined)
		})

		it("registers all 16 DAP tools (12 Layer 1 + 4 Layer 2) on session_start", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(clientState.registeredTools.sort()).toEqual(
				[
					"debug_backtrace",
					"debug_continue",
					"debug_eval",
					"debug_launch",
					"debug_last_error",
					"debug_locals",
					"debug_restart",
					"debug_set_breakpoint",
					"debug_set_variable",
					"debug_state_at",
					"debug_terminate",
					"debug_trace_calls",
					"debug_watch_change",
					"step_in",
					"step_out",
					"step_over",
				].sort(),
			)
		})
	})

	describe("session_shutdown", () => {
		it("calls clearAllSessions and shutdownAll and clears the footer", async () => {
			adapterState.active = [JS_DEBUG]
			const startCtx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, startCtx)
			await mock.handlers.session_shutdown?.()

			expect(clientState.clearAllCalled).toBe(true)
			expect(clientState.shutdownAllCalled).toBe(true)
			expect(startCtx.ui?.setStatus).toHaveBeenCalledWith("dap", undefined)
		})
	})

	describe("before_agent_start — degraded warning", () => {
		it("fires a warning once when adapters are missing", async () => {
			adapterState.missing = [DEBUGPY]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)
			await mock.handlers.before_agent_start?.()
			await mock.handlers.before_agent_start?.()

			expect(ctx.ui?.notify).toHaveBeenCalledTimes(1)
			const call = (ctx.ui?.notify as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(call[0]).toContain("DAP unavailable")
			expect(call[0]).toContain("debugpy")
			expect(call[1]).toBe("warning")
		})

		it("does not fire a warning when no adapters are missing", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)
			await mock.handlers.before_agent_start?.()

			expect(ctx.ui?.notify).not.toHaveBeenCalled()
		})
	})

	describe("system prompt block", () => {
		it("renders the ## Debugger (DAP) block when adapters are active", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(renderAllPromptBlocks()).toBeDefined()
			const output = renderAllPromptBlocks()
			expect(output).toBeDefined()
			expect(output).toContain("## Debugger (DAP)")
			expect(output).toContain("debug_launch")
		})

		it("omits the block when no adapters are active", async () => {
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(renderAllPromptBlocks()).toBeUndefined()
		})
	})

	describe("on-demand skill injection", () => {
		it("skills return undefined before any debug tool call", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			const output = renderAllPromptBlocks()
			expect(output).toBeDefined()
			expect(output).toContain("## Debugger (DAP)")
			expect(output).not.toContain("### Go Debugging")
			expect(output).not.toContain("### Python Debugging")
		})

		it("Go skill activates after a debug_ tool call when dlv is active", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			// Before debug call — no skill
			expect(renderAllPromptBlocks()).not.toContain("### Go Debugging")

			// Fire a debug tool call
			await mock.handlers.tool_call?.({ toolName: "debug_state_at" }, ctx)

			// After debug call — skill is injected
			expect(renderAllPromptBlocks()).toContain("### Go Debugging")
		})

		it("non-debug tool calls do NOT activate skills", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "bash" }, ctx)
			await mock.handlers.tool_call?.({ toolName: "read" }, ctx)

			expect(renderAllPromptBlocks()).not.toContain("### Go Debugging")
		})

		it("step_ tool calls also activate skills", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "step_over" }, ctx)

			expect(renderAllPromptBlocks()).toContain("### Go Debugging")
		})

		it("flags reset on session_start", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "debug_launch" }, ctx)
			expect(renderAllPromptBlocks()).toContain("### Go Debugging")

			// Re-fire session_start — flags should reset
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)
			expect(renderAllPromptBlocks()).not.toContain("### Go Debugging")
		})

		it("Python skill does not activate when only dlv is active", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "debug_eval" }, ctx)

			expect(renderAllPromptBlocks()).toContain("### Go Debugging")
			expect(renderAllPromptBlocks()).not.toContain("### Python Debugging")
		})

		it("TypeScript skill activates after a debug_ tool call when js-debug is active", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			expect(renderAllPromptBlocks()).not.toContain("### TypeScript/JavaScript Debugging")

			await mock.handlers.tool_call?.({ toolName: "debug_state_at" }, ctx)

			expect(renderAllPromptBlocks()).toContain("### TypeScript/JavaScript Debugging")
		})

		it("TypeScript skill does not activate when only dlv is active", async () => {
			adapterState.active = [DLV]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "debug_launch" }, ctx)

			expect(renderAllPromptBlocks()).not.toContain("### TypeScript/JavaScript Debugging")
		})

		it("TypeScript skill resets on session_start", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			await mock.handlers.tool_call?.({ toolName: "debug_continue" }, ctx)
			expect(renderAllPromptBlocks()).toContain("### TypeScript/JavaScript Debugging")

			await mock.handlers.session_start?.({ type: "session_start" }, ctx)
			expect(renderAllPromptBlocks()).not.toContain("### TypeScript/JavaScript Debugging")
		})
	})

	describe("launch failure cleanup", () => {
		it("removes the failed session and terminates its client when launch rejects (no adapter-process leak)", async () => {
			adapterState.active = [JS_DEBUG]
			const terminate = vi.fn(() => Promise.resolve())
			// A session whose launch rejects — e.g. the adapter died during its
			// internal build step (dlv) or rejected the launch request.
			clientState.sessionAfterCreate = {
				id: "test-session",
				launch: () => Promise.reject(new Error("adapter rejected launch")),
				terminate,
			}
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			const launchTool = clientState.toolObjects.get("debug_launch")
			expect(launchTool).toBeDefined()
			const result = (await launchTool?.execute("tc-1", { program: "/test/app.ts" }, undefined, undefined, ctx)) as {
				content: { type: string; text: string }[]
			}
			expect(result.content[0].text).toContain("adapter rejected launch")
			// The caller never received a session id, so debug_terminate could never
			// reach this session — launchSession must clean it up itself.
			expect(clientState.removedSessionId).toBeDefined()
			expect(terminate).toHaveBeenCalledTimes(1)
		})
	})

	describe("always-available visibility", () => {
		it("DAP tools are always visible regardless of phase", async () => {
			adapterState.active = [JS_DEBUG]
			const ctx = createCtx()
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			// Tools should be registered and visible in ALL phases — DAP tools
			// are never filtered by phase or mode.
			for (const phase of [undefined, "explore", "plan", "build", "review"]) {
				phaseState.current = phase
				await mock.handlers.tool_call?.({ toolName: "bash" }, ctx)
				const tools = [...mock.activeTools]
				expect(tools).toContain("debug_launch")
				expect(tools).toContain("debug_state_at")
				expect(tools).toContain("debug_last_error")
			}
		})
	})
})
