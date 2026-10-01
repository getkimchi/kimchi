// extensions/dap-tools-defer.test.ts
//
// Phase 1 Chunk 3: session-scoped DAP tools are hidden at session start and
// revealed one-way when an interactive debug session (debug_launch) becomes
// active. Covers:
//   - default-hidden after session_start (always-visible set intact)
//   - reveal on debug_launch success; exactly one visibility transition
//   - one-shot auto-launch (debug_state_at) does NOT reveal session tools
//   - agent-worker carve-out: isAgentWorker() skips the deferral entirely
//
// Harness mirrors dap/dap-entry.test.ts: mocks adapters/client/session
// registries so no adapter subprocess is spawned, and exercises the real
// dap.ts extension + the real cooperative visibility layer
// (prompt-construction/tool-visibility.ts).

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DAP_ALWAYS_VISIBLE_TOOL_NAMES, DAP_SESSION_TOOL_NAMES } from "./dap/tools.js"
import type { DapAdapterConfig } from "./dap/types.js"

// =============================================================================
// Mock adapter registry — controlled from tests via setAdapters()
// =============================================================================

const adapterState = vi.hoisted(() => ({
	active: [] as DapAdapterConfig[],
	missing: [] as DapAdapterConfig[],
}))

vi.mock("./dap/adapters.js", () => ({
	detectAdapters: vi.fn(() => adapterState.active),
	detectMissingAdapters: vi.fn(() => adapterState.missing),
	adapterForFile: vi.fn(() => adapterState.active[0] ?? null),
	adapterForDirectory: vi.fn(() => null),
	adapterExists: vi.fn(() => true),
	allAdapters: vi.fn(() => adapterState.active),
}))

// =============================================================================
// Mock DAP client/session — no subprocess; launch succeeds against a stub
// =============================================================================

const clientState = vi.hoisted(() => ({
	registeredTools: [] as string[],
	toolObjects: new Map<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>(),
	sessionAfterCreate: undefined as
		| {
				id: string
				launch: () => Promise<void>
				terminate: () => Promise<void>
		  }
		| undefined,
}))

vi.mock("./dap/client.js", () => ({
	DapClientRegistry: vi.fn().mockImplementation(() => ({
		getOrCreate: vi.fn(async () => ({}) as unknown),
		shutdownAll: vi.fn(),
		getAll: vi.fn(() => []),
	})),
}))

vi.mock("./dap/session.js", () => ({
	DapSessionRegistry: vi.fn().mockImplementation(() => ({
		create: vi.fn(() => clientState.sessionAfterCreate ?? { id: "test-session" }),
		get: vi.fn(() => undefined),
		remove: vi.fn(),
		clearAll: vi.fn(),
		getActive: vi.fn(() => []),
	})),
}))

vi.mock("./prompt-construction/index.js", () => ({
	createSystemPromptBlocks: () => ({ register: vi.fn() }),
}))

// Control isAgentWorker() per test — the extension reads it at session_start
// and again at reveal time.
const workerState = vi.hoisted(() => ({ isWorker: false }))
vi.mock("./agent-worker-context.js", () => ({
	isAgentWorker: () => workerState.isWorker,
}))

const dapExtension = (await import("./dap.js")).default

// =============================================================================
// Mock ExtensionAPI — captures handlers, tool registrations, active-tool set
// =============================================================================

interface CapturedHandlers {
	session_start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | null
	session_shutdown: (() => Promise<void>) | null
}

function createMockPi(): {
	pi: ExtensionAPI
	handlers: CapturedHandlers
	activeTools: Set<string>
	setActiveToolsCalls: string[][]
} {
	const activeTools = new Set<string>(["bash", "read", "edit"])
	const handlers: CapturedHandlers = { session_start: null, session_shutdown: null }
	const setActiveToolsCalls: string[][] = []

	const pi = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "session_start") handlers.session_start = handler as never
			if (event === "session_shutdown") handlers.session_shutdown = handler as never
		}),
		registerTool: vi.fn(
			(tool: { name: string; description?: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				clientState.registeredTools.push(tool.name)
				clientState.toolObjects.set(tool.name, tool)
				activeTools.add(tool.name)
			},
		),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((tools: string[]) => {
			setActiveToolsCalls.push(tools)
			activeTools.clear()
			for (const t of tools) activeTools.add(t)
		}),
	} as unknown as ExtensionAPI

	return { pi, handlers, activeTools, setActiveToolsCalls }
}

function createCtx(overrides?: Partial<ExtensionContext>): ExtensionContext {
	return {
		cwd: "/tmp/test",
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
		} as unknown as ExtensionUIContext,
		sessionManager: { getSessionId: () => "test-session-id" } as unknown as ExtensionContext["sessionManager"],
		...overrides,
	} as unknown as ExtensionContext
}

const JS_DEBUG: DapAdapterConfig = {
	name: "js-debug",
	command: "js-debug-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

// =============================================================================
// Tests
// =============================================================================

describe("DAP session-tool deferral", () => {
	let mock: ReturnType<typeof createMockPi>

	beforeEach(() => {
		mock = createMockPi()
		adapterState.active = [JS_DEBUG]
		adapterState.missing = []
		clientState.registeredTools = []
		clientState.toolObjects = new Map()
		clientState.sessionAfterCreate = {
			id: "test-session",
			launch: vi.fn(async () => {}),
			terminate: vi.fn(async () => {}),
		}
		workerState.isWorker = false
		dapExtension(mock.pi)
	})

	async function fireSessionStart(): Promise<void> {
		await mock.handlers.session_start?.(undefined, createCtx())
	}

	it("hides the 11 session tools at session start but keeps launch + one-shots visible", async () => {
		await fireSessionStart()

		for (const name of DAP_ALWAYS_VISIBLE_TOOL_NAMES) {
			expect(mock.activeTools.has(name), `${name} should be visible`).toBe(true)
		}
		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(mock.activeTools.has(name), `${name} should be hidden`).toBe(false)
		}
		// The hidden tools were still registered (availability preserved) —
		// deferral is a visibility vote, not an unregister.
		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(clientState.registeredTools).toContain(name)
		}
		expect(mock.setActiveToolsCalls).toHaveLength(1) // exactly one hide transition
	})

	it("reveals session tools once when debug_launch succeeds, and never again", async () => {
		await fireSessionStart()

		const launchTool = clientState.toolObjects.get("debug_launch")
		expect(launchTool).toBeDefined()
		if (!launchTool) throw new Error("debug_launch not registered")
		await launchTool.execute("call-1", { program: "app.ts" }, undefined, undefined, createCtx())

		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(mock.activeTools.has(name), `${name} should be visible after launch`).toBe(true)
		}
		const callsAfterLaunch = mock.setActiveToolsCalls.length
		expect(callsAfterLaunch).toBe(2) // 1 hide + 1 reveal

		// Second launch: guard prevents a second visibility transition.
		await launchTool.execute("call-2", { program: "app.ts" }, undefined, undefined, createCtx())
		expect(mock.setActiveToolsCalls.length).toBe(callsAfterLaunch)
	})

	it("does not reveal session tools from a one-shot auto-launch (debug_state_at)", async () => {
		await fireSessionStart()

		const stateAtTool = clientState.toolObjects.get("debug_state_at")
		expect(stateAtTool).toBeDefined()
		if (!stateAtTool) throw new Error("debug_state_at not registered")
		// Auto-launch path runs completeLaunch → waitForStop → collectLocals.
		// The fake session registry returns { id: "test-session" } without
		// launch(), so the launch fails fast — proving the reveal hook (which
		// sits in interactiveDeps.launchSession) was never on this path.
		await stateAtTool.execute(
			"call-1",
			{
				program: "app.ts",
				file: "app.ts",
				line: 1,
			},
			undefined,
			undefined,
			createCtx(),
		)

		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(mock.activeTools.has(name), `${name} should stay hidden after one-shot`).toBe(false)
		}
		expect(mock.setActiveToolsCalls).toHaveLength(1) // still just the hide
	})

	it("skips the deferral entirely for agent workers", async () => {
		workerState.isWorker = true
		await fireSessionStart()

		for (const name of [...DAP_ALWAYS_VISIBLE_TOOL_NAMES, ...DAP_SESSION_TOOL_NAMES]) {
			expect(mock.activeTools.has(name), `${name} should stay visible in workers`).toBe(true)
		}
		expect(mock.setActiveToolsCalls).toHaveLength(0)
	})

	it("keeps the discovery cross-references in visible tool descriptions", async () => {
		await fireSessionStart()

		const launchDescription = clientState.toolObjects.get("debug_launch")?.description ?? ""
		expect(launchDescription).toContain("appear automatically")
		expect(launchDescription).toContain("debug_set_breakpoint")

		for (const name of ["debug_state_at", "debug_last_error", "debug_trace_calls", "debug_watch_change"]) {
			const desc = clientState.toolObjects.get(name)?.description ?? ""
			expect(desc, `${name} should point at debug_launch`).toContain("debug_launch")
		}
	})
})
