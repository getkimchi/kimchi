/**
 * Integration tests for bashControlExtension: background bash processes are
 * tracked for lifecycle notices and concurrency context, but NEVER block
 * other tool calls. Write/execute tools get one once-per-turn concurrency
 * steer as reinforcement; a natural process exit steers the model without
 * claiming tools were ever blocked; a normal completion with tracked
 * handles emits one bounded follow-up per stable handle set.
 *
 * Exercises the full event wiring in bashControlExtension(pi) against a
 * fake ExtensionAPI + controllable fake registry.
 */
import type { ExtensionAPI, ExtensionContext, InputSource, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import bashControlExtension, {
	BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
	BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE,
	BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
} from "./bash-control-extension.js"
import type { ProcessRegistry } from "./process-registry.js"

// ─── Fake ExtensionAPI ────────────────────────────────────────────────────────

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown

interface SentMessage {
	customType: string
	content: { type: string; text?: string }[]
	display?: boolean
	options?: Record<string, unknown>
}

interface FakePi {
	handlers: Map<string, AnyHandler[]>
	registeredTools: string[]
	messages: SentMessage[]
	emit(event: string, payload: unknown): Promise<unknown[]>
}

function makeFakePi(): FakePi & ExtensionAPI {
	const handlers = new Map<string, AnyHandler[]>()
	const state: FakePi = {
		handlers,
		registeredTools: [],
		messages: [],
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
			state.registeredTools.push(tool.name)
		},
		sendMessage(message: Omit<SentMessage, "options">, options?: Record<string, unknown>) {
			state.messages.push({ ...message, options })
		},
	} as unknown as ExtensionAPI

	return Object.assign(state, pi) as unknown as FakePi & ExtensionAPI
}

// ─── Fake registry ────────────────────────────────────────────────────────────

interface FakeRegistry {
	whenExited(handle: string): Promise<{ exitCode: number | null }>
	/** Resolve the deferred exit promise for a handle (simulates process exit). */
	resolveExit(handle: string, exitCode: number | null): void
	/** True when a watcher promise exists for the handle. */
	watched(handle: string): boolean
	/** How many times whenExited was called for a handle. */
	watchCalls(handle: string): number
}

function makeFakeRegistry(): FakeRegistry {
	const deferred = new Map<
		string,
		{ promise: Promise<{ exitCode: number | null }>; resolve: (v: { exitCode: number | null }) => void }
	>()
	const calls = new Map<string, number>()
	const registry: FakeRegistry = {
		whenExited(handle: string) {
			calls.set(handle, (calls.get(handle) ?? 0) + 1)
			let d = deferred.get(handle)
			if (!d) {
				let resolve!: (v: { exitCode: number | null }) => void
				const promise = new Promise<{ exitCode: number | null }>((res) => {
					resolve = res
				})
				d = { promise, resolve }
				deferred.set(handle, d)
			}
			return d.promise
		},
		resolveExit(handle: string, exitCode: number | null) {
			deferred.get(handle)?.resolve({ exitCode })
		},
		watched(handle: string) {
			return deferred.has(handle) || calls.has(handle)
		},
		watchCalls(handle: string) {
			return calls.get(handle) ?? 0
		},
	}
	return registry
}

// ─── Event helpers ────────────────────────────────────────────────────────────

async function fireSessionStart(pi: ExtensionAPI): Promise<void> {
	const handlers = (pi as unknown as FakePi).handlers.get("session_start") ?? []
	for (const h of handlers) await h({}, undefined as unknown as ExtensionContext)
}

function checkinResult(handle: string): Record<string, unknown> {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "long" },
		content: [{ type: "text", text: "output so far" }],
		isError: false,
		details: { handle, checkin: true, exited: false, exitCode: null },
	}
}

async function fireToolResult(pi: ExtensionAPI, event: Record<string, unknown>): Promise<void> {
	await (pi as unknown as FakePi).emit("tool_result", event)
}

async function fireToolCall(
	pi: ExtensionAPI,
	toolName: string,
	input: Record<string, unknown> = {},
): Promise<ToolCallEventResult | undefined> {
	const handlers = (pi as unknown as FakePi).handlers.get("tool_call") ?? []
	let result: ToolCallEventResult | undefined
	for (const h of handlers) {
		const r = (await h(
			{ type: "tool_call", toolCallId: "tc1", toolName, input },
			undefined as unknown as ExtensionContext,
		)) as ToolCallEventResult | undefined
		if (r) result = r
	}
	return result
}

async function fireTurnStart(pi: ExtensionAPI): Promise<void> {
	await (pi as unknown as FakePi).emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 })
}

async function fireTurnEnd(pi: ExtensionAPI, message: { role: string; stopReason?: string }): Promise<void> {
	await (pi as unknown as FakePi).emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] })
}

async function fireInput(pi: ExtensionAPI, source: InputSource = "interactive"): Promise<void> {
	await (pi as unknown as FakePi).emit("input", { source, text: "hi" })
}

async function fireToolExecutionStart(
	pi: ExtensionAPI,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<void> {
	await (pi as unknown as FakePi).emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	})
}

async function fireToolExecutionEnd(
	pi: ExtensionAPI,
	toolCallId: string,
	toolName: string,
	isError = false,
): Promise<void> {
	await (pi as unknown as FakePi).emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: {},
		isError,
	})
}

async function fireShutdown(pi: ExtensionAPI): Promise<void> {
	await (pi as unknown as FakePi).emit("session_shutdown", {})
}

/** Let watcher promise callbacks run. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

function messages(pi: ExtensionAPI): SentMessage[] {
	return (pi as unknown as FakePi).messages
}

function steerMessages(pi: ExtensionAPI): SentMessage[] {
	return messages(pi).filter((m) => m.options?.deliverAs === "steer")
}

function followUpMessages(pi: ExtensionAPI): SentMessage[] {
	return messages(pi).filter((m) => m.options?.deliverAs === "followUp")
}

/** Start a session and track a handle via a bash checkin. */
async function startTrackedSession(pi: ExtensionAPI, registry: FakeRegistry, handle = "h1"): Promise<void> {
	bashControlExtension(pi, { getRegistry: () => registry as unknown as ProcessRegistry })
	await fireSessionStart(pi)
	await fireToolResult(pi, checkinResult(handle))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bashControlExtension — non-blocking tracking", () => {
	it("registers the bash_control tool on session_start", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi)
		await fireSessionStart(pi)

		expect((pi as unknown as FakePi).registeredTools).toContain("bash_control")
	})

	it("allows all tool calls while no background process is tracked", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi)
		await fireSessionStart(pi)

		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
		expect((await fireToolCall(pi, "bash"))?.block).toBe(false)
		expect((await fireToolCall(pi, "bash_control"))?.block).toBe(false)
	})

	it("a short-task bash result (no handle) does not track a process", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		bashControlExtension(pi, { getRegistry: () => registry as unknown as ProcessRegistry })
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

		expect((await fireToolCall(pi, "bash"))?.block).toBe(false)
		expect(registry.watched("h1")).toBe(false)
	})

	it("a background bash checkin tracks the process but does NOT block other tools", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		// read is allowed (read-only) — no steer.
		const readResult = await fireToolCall(pi, "read")
		expect(readResult?.block).toBe(false)
		expect(steerMessages(pi)).toHaveLength(0)

		// write/execute tools are allowed but get a concurrency steer.
		const before = steerMessages(pi).length
		const bashResult = await fireToolCall(pi, "bash", { command: "echo x" })
		expect(bashResult?.block).toBe(false)
		expect(steerMessages(pi).length).toBe(before + 1)
		const steer = steerMessages(pi).at(-1)
		expect(steer?.customType).toBe(BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)
		expect(steer?.options).toEqual({ deliverAs: "steer" })
		expect(steer?.content[0]?.text).toContain("h1")
		expect(steer?.content[0]?.text).toContain("conflict")

		// bash_control stays allowed without a steer.
		const controlResult = await fireToolCall(pi, "bash_control", { handle: "h1", action: "continue" })
		expect(controlResult?.block).toBe(false)
	})

	it("a bash_control continue result with checkin=true keeps tracking without re-arming the watcher", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")
		expect(registry.watchCalls("h1")).toBe(1)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "more output" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false, exitCode: null, action: "continue" },
		})

		// Still tracked — a write tool steers.
		const r = await fireToolCall(pi, "edit")
		expect(r?.block).toBe(false)
		expect(registry.watchCalls("h1")).toBe(1)
	})

	it("a bash_control continue result where the process exited drops tracking", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})

		// No longer tracked — write tools get no steer.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before)
	})

	it("a bash_control stop result drops tracking", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final output" }],
			isError: false,
			details: { handle: "h1", checkin: false, exited: true, exitCode: null, action: "stop" },
		})

		const before = steerMessages(pi).length
		await fireToolCall(pi, "bash")
		expect(steerMessages(pi).length).toBe(before)
	})

	it("natural process exit steers the model with the exit code, without availability claims", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		registry.resolveExit("h1", 0)
		await flush()

		const sent = messages(pi)
		expect(sent).toHaveLength(1)
		expect(sent[0]?.customType).toBe(BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(sent[0]?.display).toBe(false)
		expect(sent[0]?.options).toEqual({ deliverAs: "steer" })
		const text = sent[0]?.content[0]?.text ?? ""
		expect(text).toContain("h1")
		expect(text).toContain("(exit code 0)")
		expect(text).toContain("bash_control")
		// No gate-era availability language.
		expect(text).not.toContain("only bash_control is available")
		expect(text).not.toContain("all tools are available again")
		expect(text).not.toContain("available again")
	})

	it("exit watcher is a no-op when the handle was already resolved via bash_control", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		// bash_control observes the exit first.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})

		registry.resolveExit("h1", 0)
		await flush()

		// bash_control's own result carried the final state — no exit notice.
		expect(messages(pi)).toHaveLength(0)
	})

	it("multiple tracked handles: tracking persists until the last one resolves", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		// A second background bash checkin (parallel spawn in the same turn).
		await fireToolResult(pi, checkinResult("h2"))

		// A write tool steers, naming both handles.
		const r = await fireToolCall(pi, "edit")
		expect(r?.block).toBe(false)
		const steer = steerMessages(pi).at(-1)
		expect(steer?.content[0]?.text).toContain("h1")
		expect(steer?.content[0]?.text).toContain("h2")

		// First process exits on its own — notice counts the remaining process.
		registry.resolveExit("h1", 0)
		await flush()
		const exitMsgs = messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exitMsgs).toHaveLength(1)
		expect(exitMsgs[0]?.content[0]?.text).toContain("h2")

		// Second process exits — final notice, no remaining tracked.
		registry.resolveExit("h2", 1)
		await flush()
		const exitMsgs2 = messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exitMsgs2).toHaveLength(2)
		expect(exitMsgs2[1]?.content[0]?.text).toContain("(exit code 1)")
	})

	it("one handle resolving via bash_control while another is tracked keeps the latter", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")
		await fireToolResult(pi, checkinResult("h2"))

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: null, action: "stop" },
		})

		// h2 still tracked — a write tool steers.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "bash")
		expect(steerMessages(pi).length).toBe(before + 1)
		expect(steerMessages(pi).at(-1)?.content[0]?.text).toContain("h2")
	})

	it("user input preserves tracked processes and their exit watchers", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireInput(pi)
		// The process is still tracked — a write tool steers.
		const r = await fireToolCall(pi, "edit")
		expect(r?.block).toBe(false)
		expect(steerMessages(pi).at(-1)?.content[0]?.text).toContain("h1")

		// The exit watcher still fires after user input.
		registry.resolveExit("h1", 0)
		await flush()
		expect(messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
	})

	it("a bash_control error result for a handle that was never tracked does not corrupt state", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		bashControlExtension(pi, { getRegistry: () => registry as unknown as ProcessRegistry })
		await fireSessionStart(pi)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c1",
			input: { handle: "ghost", action: "continue" },
			content: [{ type: "text", text: "Error: unknown handle 'ghost'." }],
			isError: true,
			details: { handle: "ghost", exited: true, exitCode: null, action: "continue", reason: "unknown-handle" },
		})

		// Nothing tracked — no steer.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before)
	})

	it("an ambiguous bash_control result (checkin:false, exited:false) keeps tracking", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		// Transient error that never observed the process state — must NOT
		// drop tracking while the process may still be running.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "transient error" }],
			isError: true,
			details: { handle: "h1", checkin: false, exited: false, action: "continue" },
		})

		// Still tracked — a write tool steers.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before + 1)

		// The exit watcher resolves it.
		registry.resolveExit("h1", 0)
		await flush()
		expect(messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
	})

	it("tool_results from other tools do not affect tracking", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "read",
			toolCallId: "c2",
			input: { path: "/x" },
			content: [{ type: "text", text: "data" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false },
		})

		// Still tracked — a write tool steers.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "bash")
		expect(steerMessages(pi).length).toBe(before + 1)
	})

	it("session_shutdown disposes the watcher — a late exit sends no notice", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireShutdown(pi)
		registry.resolveExit("h1", 0)
		await flush()

		expect(messages(pi)).toHaveLength(0)
	})

	it("a missing registry tracks via tool_result details but the watcher is a no-op", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi, { getRegistry: () => undefined })
		await fireSessionStart(pi)
		await fireToolResult(pi, checkinResult("h1"))

		// Tracked via details — write tool steers.
		const r = await fireToolCall(pi, "edit")
		expect(r?.block).toBe(false)
		expect(steerMessages(pi).at(-1)?.content[0]?.text).toContain("h1")

		// bash_control stop drops tracking without a registry watcher.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: null, action: "stop" },
		})
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before)
	})
})

describe("bashControlExtension — once-per-turn concurrency coalescing", () => {
	it("only the first write/execute call in a turn enqueues a steer", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnStart(pi)
		const before = steerMessages(pi).length

		await fireToolCall(pi, "bash")
		await fireToolCall(pi, "edit")
		await fireToolCall(pi, "write")
		await fireToolCall(pi, "bash", { command: "x" })

		expect(steerMessages(pi).length).toBe(before + 1)
	})

	it("read-only tools do not enqueue a concurrency steer", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnStart(pi)
		const before = steerMessages(pi).length

		await fireToolCall(pi, "read")
		await fireToolCall(pi, "grep")
		await fireToolCall(pi, "find")
		await fireToolCall(pi, "lsp_diagnostics")
		await fireToolCall(pi, "lsp_hover")

		expect(steerMessages(pi).length).toBe(before)
	})

	it("turn_start rearms the once-per-turn flag", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnStart(pi)
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(1)

		await fireTurnStart(pi)
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(2)
	})

	it("lsp_rename (write) warns; read-only LSP tools do not", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnStart(pi)
		const before = steerMessages(pi).length

		await fireToolCall(pi, "lsp_diagnostics")
		await fireToolCall(pi, "lsp_hover")
		await fireToolCall(pi, "lsp_definition")
		await fireToolCall(pi, "lsp_references")
		expect(steerMessages(pi).length).toBe(before)

		await fireTurnStart(pi)
		await fireToolCall(pi, "lsp_rename")
		expect(steerMessages(pi).length).toBe(before + 1)
	})

	it("unknown tools are allowed without a concurrency steer (not mislabeled)", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnStart(pi)
		const before = steerMessages(pi).length

		await fireToolCall(pi, "some_unknown_custom_tool")
		expect(steerMessages(pi).length).toBe(before)
		// The call was still allowed.
		expect((await fireToolCall(pi, "some_unknown_custom_tool"))?.block).toBe(false)
	})
})

describe("bashControlExtension — exit watcher vs bash_control ownership", () => {
	it("no natural-exit steer when a bash_control stop settles the process before its tool_result", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "stop" })
		// kill() settles the process before bash_control can emit its result;
		// the watcher's promise reaction runs first and must defer to the
		// in-flight control call instead of steering.
		registry.resolveExit("h1", null)
		await flush()
		expect(messages(pi)).toHaveLength(0)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final output" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: null, action: "stop" },
		})
		await fireToolExecutionEnd(pi, "c2", "bash_control")

		expect(messages(pi)).toHaveLength(0)
		// No longer tracked.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before)
	})

	it("no natural-exit steer when bash_control continue observes the exit mid-flight", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "continue" })
		registry.resolveExit("h1", 0)
		await flush()
		expect(messages(pi)).toHaveLength(0)

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})
		await fireToolExecutionEnd(pi, "c2", "bash_control")

		expect(messages(pi)).toHaveLength(0)
	})

	it("a claimed exit is released silently at tool_execution_end when the control call throws (throwIfTerminal)", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "continue" })
		registry.resolveExit("h1", 1)
		await flush()
		expect(messages(pi)).toHaveLength(0)

		// throwIfTerminal threw inside execute — no resolved tool_result with
		// details, only an error execution end. Release the handle without
		// steering: the thrown error result already carried the outcome.
		await fireToolExecutionEnd(pi, "c2", "bash_control", true)

		expect(messages(pi)).toHaveLength(0)
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before)
	})

	it("an unattended exit on one handle still steers while a control call owns another", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")
		await fireToolResult(pi, checkinResult("h2"))

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "continue" })
		// h2 exits with no control call on it — unattended, steer expected.
		registry.resolveExit("h2", 0)
		await flush()

		const exitMsgs = messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exitMsgs).toHaveLength(1)
		expect(exitMsgs[0]?.content[0]?.text).toContain("h2")
		// h1 still tracked under the in-flight call.
		const before = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before + 1)

		// h1 then exits mid-flight — claimed, no steer.
		registry.resolveExit("h1", 0)
		await flush()
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})
		await fireToolExecutionEnd(pi, "c2", "bash_control")

		expect(messages(pi).filter((m) => m.customType === BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
		// No longer tracked.
		const before2 = steerMessages(pi).length
		await fireToolCall(pi, "edit")
		expect(steerMessages(pi).length).toBe(before2)
	})

	it("a registry unpublished before the watcher fires (shutdown drain) cannot steer", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		let activeRegistry = registry as unknown as ProcessRegistry | undefined
		bashControlExtension(pi, { getRegistry: () => activeRegistry })
		await fireSessionStart(pi)
		await fireToolResult(pi, checkinResult("h1"))

		// Shutdown unpublishes the session registry, THEN the drain kills
		// pending processes and settles the watcher promise.
		activeRegistry = undefined
		registry.resolveExit("h1", null)
		await flush()

		expect(messages(pi)).toHaveLength(0)
		await fireShutdown(pi)
	})
})

describe("bashControlExtension — completion guard", () => {
	it("a normal completion with a tracked handle triggers one follow-up naming that handle", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })

		const followUps = followUpMessages(pi)
		expect(followUps).toHaveLength(1)
		expect(followUps[0]?.customType).toBe(BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(followUps[0]?.options).toEqual({ deliverAs: "followUp" })
		expect(followUps[0]?.display).toBe(false)
		const text = followUps[0]?.content[0]?.text ?? ""
		expect(text).toContain("h1")
		expect(text).toContain("bash_control")
		expect(text).toContain("stop")
	})

	it("the same unchanged handle set cannot trigger a repeated follow-up", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(1)

		// Same handle set — no second reminder.
		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(1)
	})

	it("a changed handle set can trigger one new reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(1)

		// A new handle joins — different set, one new reminder.
		await fireToolResult(pi, checkinResult("h2"))
		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(2)
		const last = followUpMessages(pi).at(-1)
		expect(last?.content[0]?.text).toContain("h1")
		expect(last?.content[0]?.text).toContain("h2")
	})

	it("completion after exit does not enqueue a reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		registry.resolveExit("h1", 0)
		await flush()

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(0)
	})

	it("tool-use turns never trigger a completion reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "toolUse" })
		expect(followUpMessages(pi)).toHaveLength(0)
	})

	it("error/aborted turns never trigger a completion reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "error" })
		expect(followUpMessages(pi)).toHaveLength(0)
		await fireTurnEnd(pi, { role: "assistant", stopReason: undefined })
		expect(followUpMessages(pi)).toHaveLength(0)
	})

	it("non-assistant messages do not trigger a reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "user" })
		expect(followUpMessages(pi)).toHaveLength(0)
	})

	it("shutdown suppresses the completion guard", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireShutdown(pi)
		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(0)
	})

	it("session_start resets completion reminder state", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(1)

		// A new session resets the reminded-set — the same handle can remind once.
		await fireSessionStart(pi)
		await fireToolResult(pi, checkinResult("h1"))
		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		expect(followUpMessages(pi)).toHaveLength(2)
	})

	it("multiple tracked handles are all named in the reminder", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startTrackedSession(pi, registry, "h1")
		await fireToolResult(pi, checkinResult("h2"))

		await fireTurnEnd(pi, { role: "assistant", stopReason: "stop" })
		const followUps = followUpMessages(pi)
		expect(followUps).toHaveLength(1)
		const text = followUps[0]?.content[0]?.text ?? ""
		expect(text).toContain("h1")
		expect(text).toContain("h2")
	})
})
