/**
 * Integration tests for bashControlExtension: background cohorts are
 * tracked for lifecycle notices and concurrency context, but NEVER block
 * other tool calls. Unattended exits are delivered immediately exactly
 * once (owned exits route into the active bash_control result) and
 * same-boundary exits coalesce into one message; there is NO recurring
 * review clock — time passing alone never produces a model message; every
 * normal completion with unresolved work queues a continuation follow-up.
 *
 * Exercises the full event wiring against the shared fake ExtensionAPI
 * (`__mocks__/extension-api.ts`) plus a real registry/coordinator driven
 * by a fake BashOperations.
 */
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import bashControlExtension, {
	BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
	BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE,
	BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
} from "./bash-control-extension.js"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"
import { createTerminalDelivery } from "./terminal-delivery.js"

// Control isAgentWorker() per test: workers keep bash_control visible.
const workerState = vi.hoisted(() => ({ isWorker: false }))
vi.mock("../agent-worker-context.js", () => ({
	isAgentWorker: () => workerState.isWorker,
}))

// ─── Shared state ─────────────────────────────────────────────────────────────

let ops: FakeOps
let registry: ProcessRegistry
let coordinator: ReviewCoordinator
let state: BashSessionState
let currentState: BashSessionState | undefined

function makePiWithState(): ReturnType<typeof createExtensionApi> {
	const harness = createExtensionApi()
	bashControlExtension(harness.api, { getState: () => currentState })
	return harness
}

interface SentMessage {
	customType: string
	content: { type: string; text?: string }[]
	display?: boolean
	details?: unknown
	options?: Record<string, unknown>
}

function messages(harness: ReturnType<typeof createExtensionApi>): SentMessage[] {
	return harness.sendMessage.mock.calls.map(([message, options]) => ({
		...(message as Omit<SentMessage, "options">),
		options: options as Record<string, unknown> | undefined,
	}))
}

function followUps(harness: ReturnType<typeof createExtensionApi>, customType: string): SentMessage[] {
	return messages(harness).filter((m) => m.customType === customType)
}

beforeEach(() => {
	ops = createFakeOps()
	registry = createProcessRegistry()
	coordinator = createReviewCoordinator({ registry, handoffSeconds: 1 })
	state = { registry, coordinator, delivery: createTerminalDelivery(), limitSeconds: 600, cwd: "/test/cwd" }
	currentState = state
})

afterEach(async () => {
	vi.useRealTimers()
	await registry.shutdown()
})

function spawnRunning(command = "long-running", cwd = "/test/cwd"): string {
	const handle = registry.spawn(ops, command, cwd, undefined, { limitSeconds: 600 })
	coordinator.handleSpawned(handle)
	return handle
}

// ─── Event helpers ────────────────────────────────────────────────────────────

const ctx = createContext()

function fireSessionStart(harness: ReturnType<typeof createExtensionApi>): Promise<unknown[]> {
	return harness.emit("session_start", {}, ctx)
}

function fireToolResult(
	harness: ReturnType<typeof createExtensionApi>,
	event: Record<string, unknown>,
): Promise<unknown[]> {
	return harness.emit("tool_result", event, ctx)
}

async function fireToolCall(
	harness: ReturnType<typeof createExtensionApi>,
	toolName: string,
	input: Record<string, unknown> = {},
	toolCallId = "tc1",
): Promise<ToolCallEventResult | undefined> {
	const results = await harness.emit("tool_call", { type: "tool_call", toolCallId, toolName, input }, ctx)
	return results.filter(Boolean).at(-1) as ToolCallEventResult | undefined
}

function fireTurnStart(harness: ReturnType<typeof createExtensionApi>): Promise<unknown[]> {
	return harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx)
}

function fireTurnEnd(
	harness: ReturnType<typeof createExtensionApi>,
	message: { role: string; stopReason?: string },
): Promise<unknown[]> {
	return harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] }, ctx)
}

/** Fire a message_end event for a custom message (the acknowledgement seam). */
function fireMessageEnd(
	harness: ReturnType<typeof createExtensionApi>,
	message: Record<string, unknown>,
): Promise<unknown[]> {
	return harness.emit("message_end", { type: "message_end", message }, ctx)
}

function fireToolExecutionStart(
	harness: ReturnType<typeof createExtensionApi>,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown[]> {
	return harness.emit(
		"tool_execution_start",
		{
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args,
		},
		ctx,
	)
}

function fireToolExecutionEnd(
	harness: ReturnType<typeof createExtensionApi>,
	toolCallId: string,
	toolName: string,
	isError = false,
): Promise<unknown[]> {
	return harness.emit(
		"tool_execution_end",
		{
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: {},
			isError,
		},
		ctx,
	)
}

function fireShutdown(harness: ReturnType<typeof createExtensionApi>): Promise<unknown[]> {
	return harness.emit("session_shutdown", {}, ctx)
}

/** Let watcher promise callbacks run. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Start a session and track a handle via a bash handoff result. */
async function startTrackedSession(harness: ReturnType<typeof createExtensionApi>, handle: string): Promise<void> {
	await fireSessionStart(harness)
	await fireToolResult(harness, {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "long" },
		content: [{ type: "text", text: "output so far" }],
		isError: false,
		details: { handle, handoff: true, exited: false, exitCode: null },
	})
}

async function exitProcess(handle: string, code = 0): Promise<void> {
	const command = registry.getEntry(handle)?.commandSummary ?? ""
	ops.emitMatching(command, `output-from-${code}\n`)
	await ops.exitMatching(command, code)
	await registry.whenExited(handle)
	await flush()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("session_start", () => {
	it("registers the bash_control tool (no review-delivery wiring exists)", async () => {
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const toolNames = harness.registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name)
		expect(toolNames).toContain("bash_control")
		// The session state carries no review-delivery callback anymore.
		expect("deliverReview" in state).toBe(false)
	})
})

describe("bash_control deferral (token optimization)", () => {
	it("registers bash_control but keeps it hidden at session_start in main sessions", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)

		// Registered (availability preserved) but not advertised (surface reduced).
		expect(harness.getRegisteredTools().map((tool) => tool.name)).toContain("bash_control")
		expect(harness.getActiveToolNames()).not.toContain("bash_control")
	})

	it("reveals bash_control on the first tracked background handle", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)
		expect(harness.getActiveToolNames()).not.toContain("bash_control")

		// A short-task bash result (no handle) must NOT reveal.
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c0",
			input: { command: "echo hi" },
			content: [{ type: "text", text: "hi" }],
			isError: false,
			details: {},
		})
		expect(harness.getActiveToolNames()).not.toContain("bash_control")

		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		expect(harness.getActiveToolNames()).toContain("bash_control")
	})

	it("reveal is one-way: a second handle does not re-transition visibility", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const a = spawnRunning("first-proc")
		await startTrackedSession(harness, a)
		const transitionsAfterReveal = harness.setActiveTools.mock.calls.length
		expect(transitionsAfterReveal).toBeGreaterThan(0)

		const b = spawnRunning("second-proc")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})
		expect(harness.setActiveTools.mock.calls.length).toBe(transitionsAfterReveal)
	})

	it("keeps bash_control visible in agent workers (carve-out)", async () => {
		workerState.isWorker = true
		const harness = makePiWithState()
		await fireSessionStart(harness)
		expect(harness.getActiveToolNames()).toContain("bash_control")
		workerState.isWorker = false
	})

	it("a re-entered session_start after reveal does not re-hide bash_control", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		expect(harness.getActiveToolNames()).toContain("bash_control")

		// Resume/fork re-enters session_start; reveal is one-way per factory lifetime.
		const transitions = harness.setActiveTools.mock.calls.length
		await fireSessionStart(harness)
		expect(harness.getActiveToolNames()).toContain("bash_control")
		expect(harness.setActiveTools.mock.calls.length).toBe(transitions)
	})
})

describe("unattended exits", () => {
	it("delivers the terminal result immediately as steering with typed delivery identity and removes the handle", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)

		await exitProcess(handle, 0)
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const text = exits[0]?.content[0]?.text ?? ""
		expect(text).toContain(` handle: ${handle}`)
		expect(text).toContain("exited (exit code 0)")
		expect(text).toContain("output-from-0")
		// Steering is consumed at the next turn boundary of the running loop,
		// so delivery never depends on a tool-free assistant stop.
		expect(exits[0]?.options?.triggerTurn).toBe(true)
		expect(exits[0]?.options?.deliverAs).toBe("steer")
		// Typed identity: the message carries its deliveryId, session
		// identity, and EVERY represented handle, so message_end can
		// acknowledge all of them at once.
		const details = exits[0]?.details as { deliveryId?: string; sessionId?: string; handles?: string[] } | undefined
		expect(typeof details?.deliveryId).toBe("string")
		expect(details?.sessionId).toBe(state.delivery.sessionId)
		expect(details?.handles).toEqual([handle])
		expect(registry.getEntry(handle)).toBeUndefined()
		expect(coordinator.handles()).not.toContain(handle)
		// The outcome stays pending (recoverable) until the message_end
		// acknowledgement retires it.
		expect(state.delivery.getPending(handle)?.phase).toBe("queued")
	})

	it("includes compact statuses for remaining running handles", async () => {
		const harness = makePiWithState()
		const a = spawnRunning("first-proc")
		const b = spawnRunning("second-proc")
		await startTrackedSession(harness, a)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})

		await exitProcess(a, 0)
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const text = exits[0]?.content[0]?.text ?? ""
		expect(text).toContain("Still running")
		expect(text).toContain("second-proc")
	})

	it("coalesces exits landing in the same scheduling boundary into one message", async () => {
		const harness = makePiWithState()
		const a = spawnRunning("first-proc")
		const b = spawnRunning("second-proc")
		await startTrackedSession(harness, a)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})

		// Both processes exit in the same synchronous block: one coalesced
		// message carries BOTH terminal results — neither is lost.
		void ops.exitMatching("first-proc", 0)
		void ops.exitMatching("second-proc", 0)
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const text = exits[0]?.content[0]?.text ?? ""
		expect(text).toContain(` handle: ${a}`)
		expect(text).toContain(` handle: ${b}`)
		expect(registry.getEntry(a)).toBeUndefined()
		expect(registry.getEntry(b)).toBeUndefined()
	})

	it("restores tracking when unattended collection fails, preserving the completion continuation and a retry path", async () => {
		const harness = makePiWithState()
		// A one-time final-snapshot failure on the unattended path (e.g. a
		// transient spill-file error).
		const realFinalSnapshot = registry.finalSnapshot.bind(registry)
		let failOnce = true
		const flakyState: BashSessionState = {
			...state,
			registry: {
				...registry,
				finalSnapshot: (handle: string) => {
					if (failOnce) {
						failOnce = false
						throw new Error("snapshot boom")
					}
					return realFinalSnapshot(handle)
				},
			},
		}
		currentState = flakyState
		const handle = spawnRunning("flaky")
		await startTrackedSession(harness, handle)

		await exitProcess(handle, 0)
		await flush()
		// The exit notification failed — nothing was delivered yet.
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)

		// Tracking was restored: an assistant stop with the undelivered
		// terminal result still fires the completion continuation (the
		// reviewer's repro previously completed silently here).
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		const guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)
		const guardText = guards[0]?.content[0]?.text ?? ""
		expect(guardText).toContain("Exited, results not yet delivered")
		expect(guardText).toContain(handle)

		// The registry claim was released and the entry preserved: the
		// model's retry (a bash_control inspection) collects the result.
		expect(registry.getEntry(handle)).toBeDefined()
		currentState = state
		const tool = createBashControlToolDefinition(() => state)
		const result = await tool.execute("call-retry", { wait: false } as never, undefined, undefined, undefined as never)
		expect(result.details.exitedHandles).toEqual([handle])
		expect((result.content[0] as { text?: string }).text ?? "").toContain("exited (exit code 0)")
	})

	it("a failed collection does not drop coalesced sibling exits from the same message", async () => {
		const harness = makePiWithState()
		const realFinalSnapshot = registry.finalSnapshot.bind(registry)
		const flakyState: BashSessionState = {
			...state,
			registry: {
				...registry,
				finalSnapshot: (handle: string) => {
					if (registry.getEntry(handle)?.commandSummary === "flaky") throw new Error("snapshot boom")
					return realFinalSnapshot(handle)
				},
			},
		}
		currentState = flakyState
		const flaky = spawnRunning("flaky")
		const healthy = spawnRunning("healthy")
		await startTrackedSession(harness, flaky)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: healthy, handoff: true, exited: false },
		})

		// Both exit in the same scheduling boundary; only the flaky one fails.
		void ops.exitMatching("flaky", 0)
		void ops.exitMatching("healthy", 0)
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const text = exits[0]?.content[0]?.text ?? ""
		expect(text).toContain(` handle: ${healthy}`)
		expect(text).not.toContain(` handle: ${flaky}`)
		// The flaky handle stays tracked for the completion continuation.
		expect(registry.getEntry(flaky)).toBeDefined()
	})

	it("does NOT deliver a notification for an exit owned by an active wait (claimed silently)", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireToolExecutionStart(harness, "call-9", "bash_control", { wait: true })

		await exitProcess(handle, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)

		// The wait's consolidated result delivers the exit: tool_result releases tracking.
		// (Simulate the tool having removed the handle and reported it.)
		coordinator.handleRemoved(handle)
		await registry.remove(handle)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "call-9",
			input: { wait: true },
			content: [{ type: "text", text: "final" }],
			isError: false,
			details: { exitedHandles: [handle] },
		})
		await fireToolExecutionEnd(harness, "call-9", "bash_control")
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("an immediate inspection owns the exits it may collect", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireToolExecutionStart(harness, "call-inspect", "bash_control", { wait: false })

		await exitProcess(handle, 0)
		await flush()
		// The inspection's terminal sweep owns this exit: no notification.
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)

		// The inspection delivers it through its consolidated result.
		coordinator.handleRemoved(handle)
		await registry.remove(handle)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "call-inspect",
			input: { wait: false },
			content: [],
			isError: false,
			details: { exitedHandles: [handle] },
		})
		await fireToolExecutionEnd(harness, "call-inspect", "bash_control")
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("backfills the notification when an owning call ends without delivering the claimed exit", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireToolExecutionStart(harness, "call-10", "bash_control", { wait: true })

		await exitProcess(handle, 7)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)

		// The call ends without a tool_result carrying the exit (error path):
		// the exit must still reach the model exactly once.
		await fireToolExecutionEnd(harness, "call-10", "bash_control", true)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		expect(exits[0]?.content[0]?.text ?? "").toContain("exit code 7")
	})

	it("releases a wait's claims for still-running handles when the call ends", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireToolExecutionStart(harness, "call-12", "bash_control", { wait: true })
		// Claimed by the wait. The wait ends (e.g. aborted) with the process
		// still running — the claim must be released so a LATER exit is
		// delivered as a normal unattended exit notification.
		await fireToolExecutionEnd(harness, "call-12", "bash_control")

		await exitProcess(handle, 0)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		expect(exits[0]?.content[0]?.text ?? "").toContain(` handle: ${handle}`)
	})

	it("claims exits of stop_handles owned by an active call", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireToolExecutionStart(harness, "call-11", "bash_control", { stop_handles: [handle] })

		await exitProcess(handle, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)

		coordinator.handleRemoved(handle)
		await registry.remove(handle)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "call-11",
			input: { stop_handles: [handle] },
			content: [{ type: "text", text: "stopped" }],
			isError: false,
			details: { exitedHandles: [handle] },
		})
		await fireToolExecutionEnd(harness, "call-11", "bash_control")
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("suppresses notifications after session shutdown", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireShutdown(harness)
		await exitProcess(handle, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("suppresses notifications when the session state was replaced (stale watcher)", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		// A replacement session installed a new state: old watchers must go silent.
		currentState = undefined
		await exitProcess(handle, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})
})

describe("no recurring review clock", () => {
	it("time passing with no active wait never produces a model message", async () => {
		vi.useFakeTimers()
		const harness = makePiWithState()
		// A safety limit long enough that no deadline fires during the advance.
		const handle = registry.spawn(ops, "quiet", "/test/cwd", undefined, { limitSeconds: 10_000 })
		coordinator.handleSpawned(handle)

		await startTrackedSession(harness, handle)
		// Advance across multiple five-minute windows with no active wait:
		// no review, no unchanged-status wakeup — nothing at all.
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(messages(harness)).toHaveLength(0)
		expect(registry.getEntry(handle)?.state).toBe("running")

		// The process is still supervised: its exit IS delivered promptly.
		vi.useRealTimers()
		await exitProcess(handle, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
	})
})

describe("concurrency steer", () => {
	it("sends at most one steer per turn for write/execute tools", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireTurnStart(harness)

		const r1 = await fireToolCall(harness, "edit", { file: "x" })
		const r2 = await fireToolCall(harness, "bash", { command: "make" })
		expect(r1).toEqual({ block: false })
		expect(r2).toEqual({ block: false })
		const steers = followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)
		expect(steers).toHaveLength(1)
		expect(steers[0]?.content[0]?.text ?? "").toContain(handle)
	})

	it("does not steer read tools or bash_control", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireTurnStart(harness)

		await fireToolCall(harness, "read", { path: "x" })
		await fireToolCall(harness, "bash_control", { wait: true })
		expect(followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)).toHaveLength(0)
	})
})

describe("completion continuation", () => {
	it("emits a consolidated continuation on EVERY unresolved completion attempt", async () => {
		const harness = makePiWithState()
		const a = spawnRunning("a")
		const b = spawnRunning("b")
		await startTrackedSession(harness, a)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: {},
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})

		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		let guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)
		const text = guards[0]?.content[0]?.text ?? ""
		expect(text).toContain(a)
		expect(text).toContain(b)
		expect(text).toContain("Still running")
		expect(text).toContain("wait: true")
		expect(text).toContain("stop_handles")
		// Prose irrelevance is no longer offered as a release of ownership.
		expect(text).not.toContain("irrelevant")

		// Same stable set, second attempt: the guard fires AGAIN (no
		// lifetime suppression) — settled success requires a disposition.
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(2)

		// Resolve one process; the remaining one still requires a disposition.
		coordinator.handleRemoved(a)
		await registry.remove(a)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c3",
			input: { stop_handles: [a] },
			content: [],
			isError: false,
			details: { exitedHandles: [a] },
		})
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(3)
		expect(guards[2]?.content[0]?.text ?? "").toContain(b)
		expect(guards[2]?.content[0]?.text ?? "").not.toContain(a)

		// Fully resolved: no further continuation.
		coordinator.handleRemoved(b)
		await registry.remove(b)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "c4",
			input: { stop_handles: [b] },
			content: [],
			isError: false,
			details: { exitedHandles: [b] },
		})
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(3)
	})

	it("does not fire on tool-use turns, aborts, or with no tracked handles", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)

		await fireTurnEnd(harness, { role: "assistant", stopReason: "toolUse" })
		await fireTurnEnd(harness, { role: "assistant", stopReason: "aborted" })
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)

		await exitProcess(handle, 0)
		await flush()
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		// All exits already delivered; nothing left tracked → no continuation.
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("distinguishes terminal outcomes awaiting delivery in the continuation text", async () => {
		const harness = makePiWithState()
		const running = spawnRunning("live-one")
		const dead = spawnRunning("dead-one")
		await startTrackedSession(harness, running)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: {},
			content: [],
			isError: false,
			details: { handle: dead, handoff: true, exited: false },
		})
		// The dead process reaches a terminal state WITHOUT its exit
		// notification being delivered yet (claimed by an in-flight call
		// that never reported it) — the continuation must say so.
		await fireToolExecutionStart(harness, "call-x", "bash_control", { wait: true })
		void registry.kill(dead)
		await fireToolExecutionEnd(harness, "call-x", "bash_control", true)
		await flush()
		// The backstop notification delivered it — so no completion guard
		// fires for it. Fire with only the running one unresolved.
		const guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(0)
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		const text = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)[0]?.content[0]?.text ?? ""
		expect(text).toContain("Still running")
		expect(text).toContain(running)
	})

	it("suppresses the reminder when an already-queued terminal result will resolve the state", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		// An owning wait claims the handle, the process exits (claimed → no
		// notification yet), and the call ends WITHOUT delivering — the
		// tool_execution_end backstop queues the exit delivery.
		await fireToolExecutionStart(harness, "call-b", "bash_control", { wait: true })
		await ops.exit(0)
		const endPromise = fireToolExecutionEnd(harness, "call-b", "bash_control", true)
		// Synchronously after the backstop queued the delivery (its flush is
		// suspended at the microtask boundary), the completion attempt must
		// not add a redundant reminder — the queued exit result resolves it.
		const guardPromise = fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		await Promise.all([endPromise, guardPromise])
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)

		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
	})
})

describe("delivery acknowledgement (message_end seam)", () => {
	it("retires the pending outcomes when the queued notification is acknowledged", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		await exitProcess(handle, 0)
		await flush()
		expect(state.delivery.getPending(handle)?.phase).toBe("queued")

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		const details = exits[0]?.details as { deliveryId: string; sessionId: string; handles: string[] }
		// The installed loop emits message_end when the steering message is
		// injected into the run context — before the next provider request.
		await fireMessageEnd(harness, {
			role: "custom",
			customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
			content: [],
			display: false,
			details,
			timestamp: Date.now(),
		})
		expect(state.delivery.hasPending()).toBe(false)
	})

	it("replaces a superseded notification with a suppression note instead of repeating the payload", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		await exitProcess(handle, 0)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		const details = exits[0]?.details as { deliveryId: string; sessionId: string; handles: string[] }
		// Abort-release + control claim: a bash_control result already
		// delivered the payload authoritatively.
		state.delivery.releaseAutomatic()
		state.delivery.claimControl(handle, "call-r")

		const results = await fireMessageEnd(harness, {
			role: "custom",
			customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
			content: [{ type: "text", text: "ORIGINAL PAYLOAD output-from-0" }],
			display: false,
			details,
			timestamp: Date.now(),
		})
		const replacement = results[0] as { message?: { content?: { text?: string }[] } } | undefined
		expect(replacement?.message).toBeDefined()
		const text = replacement?.message?.content?.[0]?.text ?? ""
		expect(text).toContain("suppressed")
		// The authoritative payload is NOT repeated.
		expect(text).not.toContain("output-from-0")
		// The control-owned pending survives for its own acknowledgement.
		expect(state.delivery.getPending(handle)?.owner).toEqual({ controlCallId: "call-r" })
	})

	it("ignores acknowledgements from another session generation", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		await exitProcess(handle, 0)
		await flush()
		expect(state.delivery.getPending(handle)?.phase).toBe("queued")

		await fireMessageEnd(harness, {
			role: "custom",
			customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
			content: [],
			display: false,
			details: {
				deliveryId: "bogus",
				sessionId: "another-session-generation",
				handles: [handle],
			},
			timestamp: Date.now(),
		})
		// Not retired: identity mismatch.
		expect(state.delivery.getPending(handle)?.phase).toBe("queued")
	})

	it("acknowledges every handle of a coalesced batch through the shared delivery id", async () => {
		const harness = makePiWithState()
		const a = spawnRunning("first-exit")
		const b = spawnRunning("second-exit")
		await startTrackedSession(harness, a)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: {},
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})
		// Both exit in the same scheduling boundary → ONE message carrying BOTH handles.
		const commandA = registry.getEntry(a)?.commandSummary ?? ""
		const commandB = registry.getEntry(b)?.commandSummary ?? ""
		await Promise.all([ops.exitMatching(commandA, 0), ops.exitMatching(commandB, 0)])
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const details = exits[0]?.details as { handles: string[]; deliveryId: string; sessionId: string }
		expect([...details.handles].sort()).toEqual([a, b].sort())

		await fireMessageEnd(harness, {
			role: "custom",
			customType: BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
			content: [],
			display: false,
			details,
			timestamp: Date.now(),
		})
		expect(state.delivery.hasPending()).toBe(false)
	})

	it("retires control-owned outcomes when the bash_control result carrying them arrives", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		state.delivery.record(handle, "payload", { controlCallId: "call-z" })

		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "call-z",
			input: {},
			content: [],
			isError: false,
			details: { exitedHandles: [handle] },
		})
		expect(state.delivery.hasPending()).toBe(false)
	})
})

describe("cancellation-aware delivery", () => {
	it("an aborted run releases queued outcomes for recovery and suppresses later triggerTurn", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		await exitProcess(handle, 0)
		await flush()
		expect(state.delivery.getPending(handle)?.phase).toBe("queued")

		// The user aborts (the TUI/ACP drop queued steering): the queued
		// outcome is released back to recoverable state.
		await fireTurnEnd(harness, { role: "assistant", stopReason: "aborted" })
		expect(state.delivery.getPending(handle)?.phase).toBe("available")
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)

		// A later exit must NOT restart the cancelled run's inference.
		const later = spawnRunning("late-exit")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c3",
			input: {},
			content: [],
			isError: false,
			details: { handle: later, handoff: true, exited: false },
		})
		await exitProcess(later, 0)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		const last = exits[exits.length - 1]
		expect(last?.options?.triggerTurn).toBe(false)
		expect(last?.options?.deliverAs).toBe("steer")
		// The installed session's append path does NOT dispatch extension
		// message_end handlers (listener emit only), so the extension retires
		// the batch itself right after the synchronous append — the payload is
		// committed to the conversation, no inference wake, no stuck-queued
		// outcome that a later abort-release could recover and duplicate.
		expect(state.delivery.getPending(later)).toBeUndefined()
	})

	it("agent_start clears the cancelled-run state (a new run may be woken again)", async () => {
		const harness = makePiWithState()
		await startTrackedSession(harness, spawnRunning())
		await fireTurnEnd(harness, { role: "assistant", stopReason: "error" })

		await harness.emit("agent_start", { type: "agent_start" }, ctx)
		const handle = spawnRunning("post-retry")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c4",
			input: {},
			content: [],
			isError: false,
			details: { handle, handoff: true, exited: false },
		})
		await exitProcess(handle, 0)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits[exits.length - 1]?.options?.triggerTurn).toBe(true)
	})

	it("a failed owning call requeues its recorded payload without re-collection", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		// An owning wait claims the handle; the process exits (claimed → no
		// notification yet); the sweep collects and records the outcome, but
		// the call errors before delivering it.
		await fireToolExecutionStart(harness, "call-f", "bash_control", { wait: true })
		await ops.exit(0)
		await flush()
		state.delivery.claimControl(handle, "call-f")
		await fireToolExecutionEnd(harness, "call-f", "bash_control", true)
		await flush()
		// The backstop requeued the recorded outcome through the automatic
		// channel — the registry entry is gone (collected once).
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		expect(registry.getEntry(handle)).toBeUndefined()
	})

	it("a failed owning call requeues EVERY recorded outcome in one coalesced message", async () => {
		const harness = makePiWithState()
		const first = spawnRunning("first-multi")
		const second = spawnRunning("second-multi")
		await startTrackedSession(harness, first)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c9",
			input: {},
			content: [],
			isError: false,
			details: { handle: second, handoff: true, exited: false },
		})
		// An owning wait claims both handles; both exit while claimed (the
		// watcher stays silent), and the call's sweep collected+recorded both
		// outcomes — then the call errors before delivering them.
		await fireToolExecutionStart(harness, "call-m", "bash_control", { wait: true })
		await ops.exitMatching("first-multi", 0)
		await ops.exitMatching("second-multi", 0)
		await flush()
		state.delivery.record(first, "PAYLOAD-FIRST-MULTI", { controlCallId: "call-m" })
		state.delivery.record(second, "PAYLOAD-SECOND-MULTI", { controlCallId: "call-m" })
		await fireToolExecutionEnd(harness, "call-m", "bash_control", true)
		await flush()
		// BOTH outcomes requeue — one identified, coalesced notification.
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const details = exits[0]?.details as { handles?: string[] }
		expect([...(details?.handles ?? [])].sort()).toEqual([first, second].sort())
		const text = exits[0]?.content[0]?.text ?? ""
		expect(text).toContain("PAYLOAD-FIRST-MULTI")
		expect(text).toContain("PAYLOAD-SECOND-MULTI")
	})

	it("a synchronous enqueue failure rolls the batch back to recoverable availability", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		await startTrackedSession(harness, handle)
		harness.sendMessage.mockImplementationOnce(() => {
			throw new Error("send boom")
		})
		await exitProcess(handle, 0)
		await flush()
		// The enqueue failed synchronously; the outcome is NOT stranded in
		// `queued` (which inspection cannot claim and the completion guard
		// would wrongly suppress) — it is available again.
		expect(state.delivery.getPending(handle)?.phase).toBe("available")
		// An explicit inspection can still claim and deliver the payload.
		const tool = harness.getRegisteredTool("bash_control")
		const result = await tool.execute("call-r2", { wait: false } as never, undefined, undefined, undefined as never)
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("")
		expect(text).toContain("output-from-0")
	})

	it("does not enqueue a result whose collection crossed a session replacement", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("sleeper")
		// A state whose registry.remove swaps the session state mid-collection
		// (the async gap between snapshotting and enqueueing).
		const originalRemove = registry.remove.bind(registry)
		const replacementRegistry = createProcessRegistry()
		const replacement: BashSessionState = {
			registry: replacementRegistry,
			coordinator: createReviewCoordinator({ registry: replacementRegistry }),
			delivery: createTerminalDelivery(),
			limitSeconds: 600,
			cwd: "/test/cwd",
		}
		const swappedState: BashSessionState = {
			...state,
			registry: {
				...registry,
				remove: async (h: string) => {
					currentState = replacement
					await originalRemove(h)
				},
			},
		}
		currentState = swappedState
		await startTrackedSession(harness, handle)
		await exitProcess(handle, 0)
		await flush()
		// The stale flush re-checks the session identity after collection:
		// nothing is sent into the replacement session.
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})
})
