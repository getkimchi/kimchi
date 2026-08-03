/**
 * Integration test for bash-control-extension: asserts that when a background
 * `bash` checkin result arrives (handle + checkin:true + still running), the
 * extension suppresses every active tool except `bash_control`, and that a
 * subsequent `bash_control` result (or process exit / input) restores them.
 *
 * This exercises the full event wiring in bashControlExtension(pi) against a
 * fake ExtensionAPI, not just the ToolGating primitive in isolation.
 */
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import bashControlExtension from "./bash-control-extension.js"

// ─── Fake ExtensionAPI ────────────────────────────────────────────────────────
// Captures event handlers and tracks active tools so the test can assert the
// tool list the model would see. Reuses the shape from tool-visibility.test.ts.

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

interface FakePi {
	tools: Map<string, { definition: unknown }>
	handlers: Map<string, AnyHandler[]>
	active: string[]
	registeredTools: string[]
	emit(event: string, payload: unknown): Promise<unknown[]>
}

function makeFakePi(active: string[]): FakePi & ExtensionAPI {
	const tools = active.map((name) => ({ name }) as ToolInfo)
	const handlers = new Map<string, AnyHandler[]>()
	const state: FakePi = {
		tools: new Map(),
		handlers,
		active: [...active],
		registeredTools: [],
		async emit(event: string, payload: unknown) {
			const list = handlers.get(event) ?? []
			const results: unknown[] = []
			for (const h of list) {
				results.push(await h(payload, undefined as unknown as ExtensionContext))
			}
			return results
		},
	}

	const pi = {
		on(event: string, handler: AnyHandler) {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		registerTool(tool: { name: string }) {
			state.tools.set(tool.name, { definition: tool })
			state.registeredTools.push(tool.name)
		},
		getActiveTools: () => state.active,
		setActiveTools: (names: string[]) => {
			state.active = names
		},
		getAllTools: () => tools,
	} as unknown as ExtensionAPI

	// Merge the ExtensionAPI methods onto the fake state object so callers
	// get a single object that is both the FakePi (state) and ExtensionAPI.
	return Object.assign(state, pi) as unknown as FakePi & ExtensionAPI
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fireSessionStart(pi: ExtensionAPI): Promise<void> {
	const handlers = (pi as unknown as FakePi).handlers.get("session_start") ?? []
	for (const h of handlers) await h({}, undefined as unknown as ExtensionContext)
}

async function fireToolResult(pi: ExtensionAPI, event: Record<string, unknown>): Promise<void> {
	await (pi as unknown as FakePi).emit("tool_result", event)
}

async function fireInput(pi: ExtensionAPI): Promise<void> {
	await (pi as unknown as FakePi).emit("input", { source: "user", text: "hi" })
}

const activeBefore = ["bash", "read", "edit", "write", "grep", "find", "bash_control"]

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bashControlExtension — integration: tool list gating", () => {
	it("registers the bash_control tool on session_start", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		const fake = pi as unknown as FakePi
		expect(fake.registeredTools).toContain("bash_control")
	})

	it("a background bash checkin result makes only bash_control visible", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		// Simulate the background bash tool resolving at a checkin with a handle.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "output so far" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})

		// The model should see ONLY bash_control on its next turn.
		expect(pi.getActiveTools()).toEqual(["bash_control"])
	})

	it("a short-task bash result (no handle) does not suppress tools", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "echo hi" },
			content: [{ type: "text", text: "hi" }],
			isError: false,
			details: { checkin: false },
		})

		expect(pi.getActiveTools().slice().sort()).toEqual([...activeBefore].sort())
	})

	it("a bash result where the process exited restores tools", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		// First suppress.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "..." }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})
		expect(pi.getActiveTools()).toEqual(["bash_control"])

		// Then a bash_control continue result where the process exited.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})

		// Tools restored after the decision turn (process exited).
		expect(pi.getActiveTools().slice().sort()).toEqual([...activeBefore].sort())
	})

	it("a bash_control continue with checkin=true (process still running) re-suppresses", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		// First suppress from the bash checkin.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "..." }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})
		expect(pi.getActiveTools()).toEqual(["bash_control"])

		// bash_control continue — process still running (checkin=true).
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "more output" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null, action: "continue" },
		})

		// Should STILL be suppressed — only bash_control visible.
		expect(pi.getActiveTools()).toEqual(["bash_control"])
	})

	it("a bash_control stop restores tools (process killed)", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		// Suppress from bash checkin.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "..." }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})
		expect(pi.getActiveTools()).toEqual(["bash_control"])

		// bash_control stop — process killed (exited=true).
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final output" }],
			isError: false,
			details: { handle: "h1", checkin: false, exited: true, exitCode: null, action: "stop" },
		})

		// Tools restored after stop.
		expect(pi.getActiveTools().slice().sort()).toEqual([...activeBefore].sort())
	})

	it("a user input restores tools (safety net for interrupted turns)", async () => {
		const pi = makeFakePi(activeBefore)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "..." }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})
		expect(pi.getActiveTools()).toEqual(["bash_control"])

		await fireInput(pi)
		expect(pi.getActiveTools().slice().sort()).toEqual([...activeBefore].sort())
	})

	it("bash_control is the ONLY visible tool — no other tools leak through", async () => {
		// Use a larger tool set to be sure nothing sneaks past the filter.
		const big = ["bash", "read", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "bash_control"]
		const pi = makeFakePi(big)
		bashControlExtension(pi)
		await fireSessionStart(pi)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long" },
			content: [{ type: "text", text: "..." }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null },
		})

		const visible = pi.getActiveTools()
		expect(visible).toHaveLength(1)
		expect(visible).toEqual(["bash_control"])
	})
})
