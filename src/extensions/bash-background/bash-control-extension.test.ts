/**
 * Integration tests for bashControlExtension: while a background bash
 * process awaits a continue/stop decision, every `tool_call` except
 * `bash_control` is hard-blocked with a reason naming the pending handle(s)
 * and the remedy. A natural process exit (registry `whenExited`) releases
 * the gate and steers the model; resolved `bash_control` results do the
 * same without a notice. A user `input` event is the human-takeover safety
 * net.
 *
 * Exercises the full event wiring in bashControlExtension(pi) against a
 * fake ExtensionAPI + controllable fake registry.
 */
import type { ExtensionAPI, ExtensionContext, InputSource, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import bashControlExtension, {
	BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
	formatGateBlockReason,
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

async function fireToolCall(pi: ExtensionAPI, toolName: string): Promise<ToolCallEventResult | undefined> {
	const handlers = (pi as unknown as FakePi).handlers.get("tool_call") ?? []
	let result: ToolCallEventResult | undefined
	for (const h of handlers) {
		const r = (await h(
			{ type: "tool_call", toolCallId: "tc1", toolName, input: {} },
			undefined as unknown as ExtensionContext,
		)) as ToolCallEventResult | undefined
		if (r) result = r
	}
	return result
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

/** Start a session and close the gate with a bash checkin for `handle`. */
async function startGatedSession(pi: ExtensionAPI, registry: FakeRegistry, handle = "h1"): Promise<void> {
	bashControlExtension(pi, { getRegistry: () => registry as unknown as ProcessRegistry })
	await fireSessionStart(pi)
	await fireToolResult(pi, checkinResult(handle))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bashControlExtension — gate via tool_call hard blocks", () => {
	it("registers the bash_control tool on session_start", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi)
		await fireSessionStart(pi)

		expect((pi as unknown as FakePi).registeredTools).toContain("bash_control")
	})

	it("allows all tool calls while no background process is pending", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi)
		await fireSessionStart(pi)

		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
		expect((await fireToolCall(pi, "bash"))?.block).toBe(false)
		expect((await fireToolCall(pi, "bash_control"))?.block).toBe(false)
	})

	it("a short-task bash result (no handle) does not close the gate", async () => {
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

	it("a background bash checkin closes the gate: non-bash_control calls are blocked with a steering reason", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		const blockedRead = await fireToolCall(pi, "read")
		expect(blockedRead?.block).toBe(true)
		expect(blockedRead?.reason).toContain("read")
		expect(blockedRead?.reason).toContain("h1")
		expect(blockedRead?.reason).toContain("bash_control")

		// New bash spawns are blocked too — the model must drive the pending
		// process instead of starting parallel work.
		const blockedBash = await fireToolCall(pi, "bash")
		expect(blockedBash?.block).toBe(true)
		expect(blockedBash?.reason).toContain("h1")

		// bash_control stays available.
		expect((await fireToolCall(pi, "bash_control"))?.block).toBe(false)
	})

	it("a bash_control continue result with checkin=true keeps the gate closed without re-arming the watcher", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")
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

		expect((await fireToolCall(pi, "read"))?.block).toBe(true)
		// Same handle must not arm a second watcher.
		expect(registry.watchCalls("h1")).toBe(1)
	})

	it("a bash_control continue result where the process exited opens the gate", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: 0, action: "continue" },
		})

		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("a bash_control stop result opens the gate", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final output" }],
			isError: false,
			details: { handle: "h1", checkin: false, exited: true, exitCode: null, action: "stop" },
		})

		expect((await fireToolCall(pi, "bash"))?.block).toBe(false)
	})

	it("natural process exit opens the gate and steers the model with the exit code", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		expect((await fireToolCall(pi, "read"))?.block).toBe(true)

		registry.resolveExit("h1", 0)
		await flush()

		expect((await fireToolCall(pi, "read"))?.block).toBe(false)

		const sent = messages(pi)
		expect(sent).toHaveLength(1)
		expect(sent[0]?.customType).toBe(BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(sent[0]?.display).toBe(false)
		expect(sent[0]?.options).toEqual({ deliverAs: "steer" })
		const text = sent[0]?.content[0]?.text ?? ""
		expect(text).toContain("h1")
		expect(text).toContain("(exit code 0)")
		expect(text).toContain("bash_control")
		expect(text).toContain("all tools are available again")
	})

	it("exit watcher is a no-op when the handle was already resolved via bash_control", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

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

		// bash_control's own result carried the final state — no notice.
		expect(messages(pi)).toHaveLength(0)
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("multiple pending handles: gate stays closed until the last one resolves", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		// A second background bash checkin (parallel spawn in the same turn).
		await fireToolResult(pi, checkinResult("h2"))

		const blocked = await fireToolCall(pi, "edit")
		expect(blocked?.block).toBe(true)
		expect(blocked?.reason).toContain("h1")
		expect(blocked?.reason).toContain("h2")

		// First process exits on its own — gate stays closed, notice counts
		// the remaining process.
		registry.resolveExit("h1", 0)
		await flush()
		expect((await fireToolCall(pi, "edit"))?.block).toBe(true)
		expect(messages(pi)).toHaveLength(1)
		expect(messages(pi)[0]?.content[0]?.text).toContain("1 background process still pending")

		// Second process exits — gate opens.
		registry.resolveExit("h2", 1)
		await flush()
		expect((await fireToolCall(pi, "edit"))?.block).toBe(false)
		expect(messages(pi)).toHaveLength(2)
		expect(messages(pi)[1]?.content[0]?.text).toContain("(exit code 1)")
	})

	it("one handle resolving via bash_control while another pends keeps the gate closed", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")
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

		expect((await fireToolCall(pi, "bash"))?.block).toBe(true)
	})

	it("a user input clears the gate (safety net); the exit watcher afterwards is a no-op", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireInput(pi)
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)

		registry.resolveExit("h1", 0)
		await flush()
		expect(messages(pi)).toHaveLength(0)
	})

	it("extension-sourced input does NOT clear the gate", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireInput(pi, "extension")
		expect((await fireToolCall(pi, "read"))?.block).toBe(true)
	})

	it("a bash_control error result for a handle that was never pending does not corrupt gate state", async () => {
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

		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("an ambiguous bash_control result (checkin:false, exited:false) keeps the gate closed", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		// Transient error that never observed the process state — must NOT
		// open the gate while the process may still be running.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "continue" },
			content: [{ type: "text", text: "transient error" }],
			isError: true,
			details: { handle: "h1", checkin: false, exited: false, action: "continue" },
		})

		expect((await fireToolCall(pi, "read"))?.block).toBe(true)

		// The exit watcher (or a later bash_control result) resolves it.
		registry.resolveExit("h1", 0)
		await flush()
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("tool_results from other tools do not affect the gate", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "read",
			toolCallId: "c2",
			input: { path: "/x" },
			content: [{ type: "text", text: "data" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false },
		})

		expect((await fireToolCall(pi, "bash"))?.block).toBe(true)
	})

	it("session_shutdown disposes the watcher — a late exit sends no notice", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireShutdown(pi)
		registry.resolveExit("h1", 0)
		await flush()

		expect(messages(pi)).toHaveLength(0)
	})

	it("a missing registry does not throw and leaves the gate to bash_control/input", async () => {
		const pi = makeFakePi()
		bashControlExtension(pi, { getRegistry: () => undefined })
		await fireSessionStart(pi)
		await fireToolResult(pi, checkinResult("h1"))

		expect((await fireToolCall(pi, "read"))?.block).toBe(true)

		// bash_control stop still opens the gate without a registry watcher.
		await fireToolResult(pi, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c2",
			input: { handle: "h1", action: "stop" },
			content: [{ type: "text", text: "final" }],
			isError: false,
			details: { handle: "h1", exited: true, exitCode: null, action: "stop" },
		})
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})
})

describe("bashControlExtension — exit watcher vs bash_control ownership", () => {
	it("no natural-exit steer when a bash_control stop settles the process before its tool_result", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

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
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("no natural-exit steer when bash_control continue observes the exit mid-flight", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

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
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("a claimed exit is released silently at tool_execution_end when the control call throws (throwIfTerminal)", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "continue" })
		registry.resolveExit("h1", 1)
		await flush()
		expect(messages(pi)).toHaveLength(0)

		// throwIfTerminal threw inside execute — no resolved tool_result with
		// details, only an error execution end. Release the handle without
		// steering: the thrown error result already carried the outcome.
		await fireToolExecutionEnd(pi, "c2", "bash_control", true)

		expect(messages(pi)).toHaveLength(0)
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
	})

	it("an unattended exit on one handle still steers while a control call owns another", async () => {
		const registry = makeFakeRegistry()
		const pi = makeFakePi()
		await startGatedSession(pi, registry, "h1")
		await fireToolResult(pi, checkinResult("h2"))

		await fireToolExecutionStart(pi, "c2", "bash_control", { handle: "h1", action: "continue" })
		// h2 exits with no control call on it — unattended, steer expected.
		registry.resolveExit("h2", 0)
		await flush()

		expect(messages(pi)).toHaveLength(1)
		expect(messages(pi)[0]?.content[0]?.text).toContain("h2")
		// Gate stays closed: h1 still pending under the in-flight call.
		expect((await fireToolCall(pi, "read"))?.block).toBe(true)

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

		expect(messages(pi)).toHaveLength(1)
		expect((await fireToolCall(pi, "read"))?.block).toBe(false)
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

describe("formatGateBlockReason", () => {
	it("single handle: singular grammar, names handle and remedy", () => {
		const reason = formatGateBlockReason("read", ["h1"])
		expect(reason).toContain("Blocked read")
		expect(reason).toContain("process awaiting")
		expect(reason).toContain("h1")
		expect(reason).toContain('action "continue"')
		expect(reason).toContain('"stop"')
	})

	it("multiple handles: plural grammar, lists all", () => {
		const reason = formatGateBlockReason("bash", ["h1", "h2"])
		expect(reason).toContain("Blocked bash")
		expect(reason).toContain("processes awaiting")
		expect(reason).toContain("h1, h2")
		expect(reason).toContain("all pending processes")
	})
})
