// extensions/dap/tools.test.ts
//
// Verifies the Layer 1 DAP tool schemas, parameter validation, and sessionId
// routing. Each tool takes a sessionId (except debug_launch which creates one)
// and delegates to DapSession. We inject a fake DapToolDeps with a stub
// DapSession so we can assert the tools call the right session methods with
// the right args, and that sessionId routing works (missing sessionId → error).
//
// No subprocesses are spawned — all assertions are on the stub session.

import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Container } from "@earendil-works/pi-tui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DapSession } from "./session.js"
import type { DapToolDeps, LaunchSessionOptions } from "./tools.js"
import { createLayer1Tools, dapRenderCall } from "./tools.js"
import type { Breakpoint, DapAdapterConfig, Scope, StackFrame, Variable } from "./types.js"

// =============================================================================
// Stub DapSession — captures method calls and returns canned values
// =============================================================================

interface StubSession extends DapSession {
	id: string
	adapter: DapAdapterConfig
	launch: ReturnType<typeof vi.fn>
	setBreakpoint: ReturnType<typeof vi.fn>
	continue: ReturnType<typeof vi.fn>
	stepIn: ReturnType<typeof vi.fn>
	stepOver: ReturnType<typeof vi.fn>
	stepOut: ReturnType<typeof vi.fn>
	getStackFrame: ReturnType<typeof vi.fn>
	getScopes: ReturnType<typeof vi.fn>
	getVariables: ReturnType<typeof vi.fn>
	evaluate: ReturnType<typeof vi.fn>
	terminate: ReturnType<typeof vi.fn>
	isLaunched: boolean
	isTerminated: boolean
	threadId: number | null
}

function createStubSession(id = "sess-123-456-789"): StubSession {
	const adapter: DapAdapterConfig = {
		name: "js-debug",
		command: "js-debug-adapter",
		args: [],
		languages: ["typescript"],
		extensions: [".ts"],
		launchType: "node",
	}
	return {
		id,
		adapter,
		cwd: "/tmp",
		launch: vi.fn().mockResolvedValue(undefined),
		setBreakpoint: vi.fn().mockResolvedValue({ verified: true, line: 10 } as Breakpoint),
		continue: vi.fn().mockResolvedValue({ reason: "breakpoint", threadId: 1, allThreadsStopped: false }),
		stepIn: vi.fn().mockResolvedValue({ reason: "step", threadId: 1, allThreadsStopped: false }),
		stepOver: vi.fn().mockResolvedValue({ reason: "step", threadId: 1, allThreadsStopped: false }),
		stepOut: vi.fn().mockResolvedValue({ reason: "step", threadId: 1, allThreadsStopped: false }),
		getStackFrame: vi.fn().mockResolvedValue([] as StackFrame[]),
		getScopes: vi.fn().mockResolvedValue([] as Scope[]),
		getVariables: vi.fn().mockResolvedValue([] as Variable[]),
		evaluate: vi.fn().mockResolvedValue({ result: "42", variablesReference: 0 }),
		terminate: vi.fn().mockResolvedValue(undefined),
		isLaunched: true,
		isTerminated: false,
		threadId: 1,
	} as unknown as StubSession
}

// =============================================================================
// Stub deps — getSession returns a registered stub; launchSession creates one
// =============================================================================

function createDeps(stub?: StubSession): DapToolDeps {
	const sessions = new Map<string, StubSession>()
	if (stub) sessions.set(stub.id, stub)
	return {
		cwd: "/tmp",
		getSession: (id: string) => sessions.get(id),
		launchSession: async (opts: LaunchSessionOptions) => {
			const s = createStubSession("launched-abc-def-123")
			sessions.set(s.id, s)
			await s.launch(opts)
			return s
		},
	}
}

// =============================================================================
// Helpers — call a tool's execute and return the text
// =============================================================================

async function executeTool(
	tools: ReturnType<typeof createLayer1Tools>,
	name: string,
	params: Record<string, unknown>,
): Promise<string> {
	const tool = tools.find((t) => t.name === name)
	if (!tool) throw new Error(`tool ${name} not found`)
	const result = await tool.execute("tc-1", params as never, undefined, undefined, {
		cwd: "/tmp",
	} as never)
	const text = result.content[0]
	if (text.type !== "text") throw new Error("expected text content")
	return text.text
}

// =============================================================================
// Tests
// =============================================================================

const FAKE_THEME: Theme = {
	fg: () => "",
	bold: (s: string) => s,
} as unknown as Theme

describe("Layer 1 DAP tools", () => {
	let stub: StubSession
	let deps: DapToolDeps
	let tools: ReturnType<typeof createLayer1Tools>

	beforeEach(() => {
		stub = createStubSession()
		deps = createDeps(stub)
		tools = createLayer1Tools(deps)
	})

	describe("tool registration", () => {
		it("registers all 10 Layer 1 tools", () => {
			const names = tools.map((t) => t.name).sort()
			expect(names).toEqual(
				[
					"debug_backtrace",
					"debug_continue",
					"debug_eval",
					"debug_launch",
					"debug_locals",
					"debug_set_breakpoint",
					"debug_terminate",
					"step_in",
					"step_out",
					"step_over",
				].sort(),
			)
		})

		it("every tool has a label, description, parameters, and renderCall", () => {
			for (const tool of tools) {
				expect(tool.label).toBeTruthy()
				expect(tool.description).toBeTruthy()
				expect(tool.parameters).toBeTruthy()
				expect(tool.renderCall).toBeTruthy()
			}
		})
	})

	describe("debug_launch", () => {
		it("creates a session and returns the session id + adapter", async () => {
			const text = await executeTool(tools, "debug_launch", {
				program: "/tmp/app.ts",
			})
			expect(text).toContain("session_id:")
			expect(text).toContain("launched-abc-def-123")
			expect(text).toContain("adapter:")
			expect(text).toContain("js-debug")
		})

		it("returns an error when launchSession throws", async () => {
			deps = {
				cwd: "/tmp",
				getSession: () => undefined,
				launchSession: async () => {
					throw new Error("adapter not found")
				},
			}
			tools = createLayer1Tools(deps)
			const text = await executeTool(tools, "debug_launch", { program: "/tmp/app.ts" })
			expect(text).toContain("Error: adapter not found")
		})
	})

	describe("sessionId routing", () => {
		it("debug_set_breakpoint routes by session_id to session.setBreakpoint", async () => {
			const text = await executeTool(tools, "debug_set_breakpoint", {
				session_id: stub.id,
				file: "/tmp/app.ts",
				line: 10,
			})
			expect(stub.setBreakpoint).toHaveBeenCalledWith("/tmp/app.ts", 10, undefined)
			expect(text).toContain("Breakpoint verified")
			expect(text).toContain("/tmp/app.ts:10")
		})

		it("debug_continue routes to session.continue", async () => {
			const text = await executeTool(tools, "debug_continue", { session_id: stub.id })
			expect(stub.continue).toHaveBeenCalledTimes(1)
			expect(text).toContain("Stopped: breakpoint")
		})

		it("step_in routes to session.stepIn", async () => {
			await executeTool(tools, "step_in", { session_id: stub.id })
			expect(stub.stepIn).toHaveBeenCalledTimes(1)
		})

		it("step_over routes to session.stepOver", async () => {
			await executeTool(tools, "step_over", { session_id: stub.id })
			expect(stub.stepOver).toHaveBeenCalledTimes(1)
		})

		it("step_out routes to session.stepOut", async () => {
			await executeTool(tools, "step_out", { session_id: stub.id })
			expect(stub.stepOut).toHaveBeenCalledTimes(1)
		})

		it("debug_terminate routes to session.terminate", async () => {
			const text = await executeTool(tools, "debug_terminate", { session_id: stub.id })
			expect(stub.terminate).toHaveBeenCalledTimes(1)
			expect(text).toContain("terminated")
		})

		it("returns an error for unknown session_id", async () => {
			const text = await executeTool(tools, "debug_continue", { session_id: "nope" })
			expect(text).toContain("Error: No DAP session found for sessionId: nope")
		})
	})

	describe("debug_locals", () => {
		it("collects variables from all scopes and lists them", async () => {
			stub.getStackFrame.mockResolvedValue([{ id: 7, name: "main", line: 1, column: 1 }])
			stub.getScopes.mockResolvedValue([
				{ name: "Locals", variablesReference: 100, expensive: false },
				{ name: "Args", variablesReference: 0, expensive: false },
			])
			stub.getVariables.mockResolvedValue([
				{ name: "x", value: "42", type: "number", variablesReference: 0 },
				{ name: "y", value: '"hi"', type: "string", variablesReference: 0 },
			])
			const text = await executeTool(tools, "debug_locals", { session_id: stub.id })
			expect(stub.getScopes).toHaveBeenCalled()
			expect(stub.getVariables).toHaveBeenCalledWith(100)
			expect(text).toContain("x = 42 (number)")
			expect(text).toContain('y = "hi" (string)')
		})

		it("uses the top frame id when frame_id is omitted", async () => {
			stub.getStackFrame.mockResolvedValue([{ id: 7, name: "main", line: 1, column: 1 }])
			stub.getScopes.mockResolvedValue([])
			await executeTool(tools, "debug_locals", { session_id: stub.id })
			expect(stub.getScopes).toHaveBeenCalledWith(7)
		})

		it("passes an explicit frame_id through", async () => {
			stub.getScopes.mockResolvedValue([])
			await executeTool(tools, "debug_locals", { session_id: stub.id, frame_id: 42 })
			expect(stub.getScopes).toHaveBeenCalledWith(42)
		})

		it("returns 'No local variables' when all scopes are empty", async () => {
			stub.getScopes.mockResolvedValue([{ name: "Locals", variablesReference: 0, expensive: false }])
			const text = await executeTool(tools, "debug_locals", {
				session_id: stub.id,
				frame_id: 1,
			})
			expect(text).toContain("No local variables")
		})
	})

	describe("debug_eval", () => {
		it("evaluates an expression in the top frame and returns the result", async () => {
			stub.getStackFrame.mockResolvedValue([{ id: 7, name: "main", line: 1, column: 1 }])
			stub.evaluate.mockResolvedValue({ result: "99", type: "number", variablesReference: 0 })
			const text = await executeTool(tools, "debug_eval", {
				session_id: stub.id,
				expression: "x + 1",
			})
			expect(stub.evaluate).toHaveBeenCalledWith("x + 1", 7)
			expect(text).toContain("99 (number)")
		})

		it("uses an explicit frame_id when provided", async () => {
			stub.evaluate.mockResolvedValue({ result: "ok", variablesReference: 0 })
			await executeTool(tools, "debug_eval", {
				session_id: stub.id,
				expression: "y",
				frame_id: 5,
			})
			expect(stub.evaluate).toHaveBeenCalledWith("y", 5)
		})
	})

	describe("debug_backtrace", () => {
		it("lists frames with id, name, file, and line", async () => {
			stub.getStackFrame.mockResolvedValue([
				{ id: 1, name: "main", line: 5, column: 1, source: { path: "/tmp/app.ts" } },
				{ id: 2, name: "foo", line: 10, column: 1, source: { path: "/tmp/app.ts" } },
			])
			const text = await executeTool(tools, "debug_backtrace", { session_id: stub.id })
			expect(text).toContain("#0 [frame 1] main at /tmp/app.ts:5")
			expect(text).toContain("#1 [frame 2] foo at /tmp/app.ts:10")
		})

		it("returns 'No stack frames' when the stack is empty", async () => {
			stub.getStackFrame.mockResolvedValue([])
			const text = await executeTool(tools, "debug_backtrace", { session_id: stub.id })
			expect(text).toContain("No stack frames")
		})
	})

	describe("error handling", () => {
		it("wraps session method errors in 'Error:' prefix", async () => {
			stub.continue.mockRejectedValue(new Error("adapter crashed"))
			const text = await executeTool(tools, "debug_continue", { session_id: stub.id })
			expect(text).toBe("Error: adapter crashed")
		})
	})

	describe("dapRenderCall", () => {
		it("renders a header with the label and session id", () => {
			const render = dapRenderCall("DAP: Test")
			const container = render({ session_id: "abcdef1234567890" }, FAKE_THEME, {
				lastComponent: undefined,
			}) as unknown as Container
			// We can't easily inspect Container internals without the TUI runtime,
			// but we can assert it doesn't throw and returns a Container instance.
			expect(container).toBeDefined()
		})

		it("renders without a session_id (debug_launch case)", () => {
			const render = dapRenderCall("DAP: Launch")
			const container = render({ program: "/tmp/app.ts" }, FAKE_THEME, {
				lastComponent: undefined,
			}) as unknown as Container
			expect(container).toBeDefined()
		})
	})
})
