// extensions/dap/phase-visibility.test.ts
//
// Verifies DAP tool visibility is phase-based:
//   - DAP tools are disabled (hidden) during explore/plan phases
//   - DAP tools are enabled (visible) during build/review phases
//   - DAP tools are enabled by default (phase=undefined, no ferment active)
//   - Phase transitions trigger enable/disable; same-phase calls are idempotent
//   - Votes don't leak across sessions: after session_shutdown + session_start,
//     DAP tools start enabled regardless of the previous session's phase
//
// Uses the REAL createToolVisibility (not mocked) so the vote-based registry
// and session_shutdown cleanup are exercised end-to-end. Mocks getCurrentPhase
// from tags.js so we can control the phase per test.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DapAdapterConfig } from "./types.js"

// =============================================================================
// Mock adapter registry — one active adapter so tools are registered
// =============================================================================

const JS_DEBUG: DapAdapterConfig = {
	name: "js-debug",
	command: "js-debug-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

const adapterState = vi.hoisted(() => ({
	active: [] as DapAdapterConfig[],
	missing: [] as DapAdapterConfig[],
}))

vi.mock("./adapters.js", () => ({
	detectAdapters: vi.fn(() => adapterState.active),
	detectMissingAdapters: vi.fn(() => adapterState.missing),
	adapterForFile: vi.fn(() => adapterState.active[0] ?? null),
	allAdapters: vi.fn(() => adapterState.active),
}))

// =============================================================================
// Mock DAP client + session — no subprocesses
// =============================================================================

vi.mock("./client.js", () => ({
	getOrCreateClient: vi.fn(async () => ({}) as unknown),
	shutdownAll: vi.fn(),
}))

vi.mock("./session.js", () => ({
	createSession: vi.fn(() => ({ id: "test-session" })),
	getSession: vi.fn(() => undefined),
	clearAllSessions: vi.fn(),
}))

// =============================================================================
// Mock system prompt blocks — capture render fn
// =============================================================================

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: () => ({
		register: vi.fn(),
	}),
}))

// =============================================================================
// Mock getCurrentPhase — controllable per test
// =============================================================================

const phaseState = vi.hoisted(() => ({
	current: undefined as string | undefined,
}))

vi.mock("../tags.js", () => ({
	getCurrentPhase: vi.fn(() => phaseState.current),
}))

// Import the default export AFTER mocks are set up.
const dapExtension = (await import("../dap.js")).default

// =============================================================================
// All 14 DAP tool names (must match DAP_TOOL_NAMES in dap.ts)
// =============================================================================

const DAP_TOOL_NAMES = [
	"debug_launch",
	"debug_set_breakpoint",
	"debug_continue",
	"debug_locals",
	"debug_eval",
	"debug_backtrace",
	"debug_terminate",
	"step_in",
	"step_over",
	"step_out",
	"debug_state_at",
	"debug_last_error",
	"debug_trace_calls",
	"debug_watch_change",
]

// =============================================================================
// Mock ExtensionAPI — tracks activeTools, captures all event handlers
// =============================================================================

interface MockSessionManager {
	getSessionId: () => string
}

function createMockPi(initialTools: string[] = []) {
	const activeTools = new Set<string>(initialTools)
	const shutdownHandlers: Array<() => unknown> = []
	const handlers: {
		session_start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | null
		before_agent_start: (() => Promise<void>) | null
		tool_call: ((event: { toolName: string }, ctx: ExtensionContext) => unknown) | null
	} = {
		session_start: null,
		before_agent_start: null,
		tool_call: null,
	}

	const sessionManager: MockSessionManager = {
		getSessionId: () => "test-session-id",
	}

	const getActiveTools = vi.fn(() => [...activeTools])
	const setActiveTools = vi.fn((tools: string[]) => {
		activeTools.clear()
		for (const t of tools) activeTools.add(t)
	})

	const pi = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "session_start") handlers.session_start = handler as never
			else if (event === "session_shutdown") shutdownHandlers.push(handler)
			else if (event === "before_agent_start") handlers.before_agent_start = handler as never
			else if (event === "tool_call") handlers.tool_call = handler as never
		}),
		registerTool: vi.fn((tool: { name: string }) => {
			activeTools.add(tool.name)
		}),
		getActiveTools,
		setActiveTools,
	} as unknown as ExtensionAPI

	return { pi, handlers, shutdownHandlers, sessionManager, activeTools, getActiveTools, setActiveTools }
}

function createCtx(sessionManager: MockSessionManager): ExtensionContext {
	return {
		cwd: "/tmp/test",
		mode: "tui",
		hasUI: true,
		ui: { setStatus: vi.fn(), notify: vi.fn() } as unknown as ExtensionUIContext,
		sessionManager: sessionManager as unknown as ExtensionContext["sessionManager"],
	} as unknown as ExtensionContext
}

// =============================================================================
// Helpers
// =============================================================================

/** Fire a tool_call event and return the active tools afterward. */
async function fireToolCall(mock: ReturnType<typeof createMockPi>): Promise<string[]> {
	const ctx = createCtx(mock.sessionManager)
	await mock.handlers.tool_call?.({ toolName: "bash" }, ctx)
	return mock.getActiveTools()
}

/** Assert all DAP tools are present in the active tools list. */
function expectDapToolsPresent(tools: string[]): void {
	for (const name of DAP_TOOL_NAMES) {
		expect(tools).toContain(name)
	}
}

/** Assert NO DAP tools are present in the active tools list. */
function expectDapToolsAbsent(tools: string[]): void {
	for (const name of DAP_TOOL_NAMES) {
		expect(tools).not.toContain(name)
	}
}

// =============================================================================
// Tests
// =============================================================================

describe("DAP phase-based tool visibility", () => {
	let mock: ReturnType<typeof createMockPi>

	beforeEach(async () => {
		phaseState.current = undefined
		adapterState.active = [JS_DEBUG]
		adapterState.missing = []
		mock = createMockPi(["bash", "read", "edit"]) // non-DAP tools start active
		dapExtension(mock.pi)

		// Fire session_start to register tools
		const ctx = createCtx(mock.sessionManager)
		await mock.handlers.session_start?.({ type: "session_start" }, ctx)
	})

	describe("default state (no ferment active)", () => {
		it("DAP tools are visible when phase is undefined", async () => {
			phaseState.current = undefined
			const tools = await fireToolCall(mock)
			expectDapToolsPresent(tools)
		})
	})

	describe("explore/plan phases hide DAP tools", () => {
		it("disables DAP tools during explore phase", async () => {
			phaseState.current = "explore"
			const tools = await fireToolCall(mock)
			expectDapToolsAbsent(tools)
			// Non-DAP tools are unaffected
			expect(tools).toContain("bash")
			expect(tools).toContain("read")
			expect(tools).toContain("edit")
		})

		it("disables DAP tools during plan phase", async () => {
			phaseState.current = "plan"
			const tools = await fireToolCall(mock)
			expectDapToolsAbsent(tools)
			expect(tools).toContain("bash")
		})
	})

	describe("build/review phases show DAP tools", () => {
		it("enables DAP tools during build phase", async () => {
			// First hide them (explore), then show (build) — proves toggle works
			phaseState.current = "explore"
			await fireToolCall(mock)
			expectDapToolsAbsent(mock.getActiveTools())

			phaseState.current = "build"
			const tools = await fireToolCall(mock)
			expectDapToolsPresent(tools)
		})

		it("enables DAP tools during review phase", async () => {
			phaseState.current = "plan"
			await fireToolCall(mock)
			expectDapToolsAbsent(mock.getActiveTools())

			phaseState.current = "review"
			const tools = await fireToolCall(mock)
			expectDapToolsPresent(tools)
		})
	})

	describe("phase transitions", () => {
		it("explore → build → plan → review toggles correctly", async () => {
			phaseState.current = "explore"
			expectDapToolsAbsent(await fireToolCall(mock))

			phaseState.current = "build"
			expectDapToolsPresent(await fireToolCall(mock))

			phaseState.current = "plan"
			expectDapToolsAbsent(await fireToolCall(mock))

			phaseState.current = "review"
			expectDapToolsPresent(await fireToolCall(mock))
		})

		it("same-phase calls are idempotent (setActiveTools not called redundantly)", async () => {
			phaseState.current = "explore"
			await fireToolCall(mock)
			const callCountAfterFirst = mock.setActiveTools.mock.calls.length

			// Second tool_call with same phase — handler should skip
			await fireToolCall(mock)
			expect(mock.setActiveTools.mock.calls.length).toBe(callCountAfterFirst)
		})
	})

	describe("votes don't leak across sessions", () => {
		it("after session_shutdown + session_start, DAP tools start enabled when phase is undefined", async () => {
			// Session 1: disable DAP tools in explore phase
			phaseState.current = "explore"
			await fireToolCall(mock)
			expectDapToolsAbsent(mock.getActiveTools())

			// Session shutdown — fires both dap.ts and tool-visibility handlers
			for (const h of mock.shutdownHandlers) {
				await h()
			}

			// Session 2: new session_start (same extension instance, same pi)
			mock = createMockPi(["bash", "read", "edit"])
			dapExtension(mock.pi)
			const ctx = createCtx(mock.sessionManager)
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			// Phase is undefined (no ferment) — DAP tools should be enabled
			phaseState.current = undefined
			const tools = await fireToolCall(mock)
			expectDapToolsPresent(tools)
		})

		it("after session_shutdown + session_start, DAP tools are disabled when phase is explore", async () => {
			// Session 1: build phase — tools enabled
			phaseState.current = "build"
			await fireToolCall(mock)
			expectDapToolsPresent(mock.getActiveTools())

			// Session shutdown
			for (const h of mock.shutdownHandlers) {
				await h()
			}

			// Session 2: explore phase — tools should be disabled
			mock = createMockPi(["bash"])
			dapExtension(mock.pi)
			const ctx = createCtx(mock.sessionManager)
			await mock.handlers.session_start?.({ type: "session_start" }, ctx)

			phaseState.current = "explore"
			const tools = await fireToolCall(mock)
			expectDapToolsAbsent(tools)
			expect(tools).toContain("bash")
		})
	})
})
