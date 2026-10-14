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
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import bashControlExtension, {
	BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
	BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE,
	BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
} from "./bash-control-extension.js"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"

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
	state = { registry, coordinator, limitSeconds: 600, cwd: "/test/cwd" }
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

describe("bash_control static tool surface", () => {
	it("registers and advertises bash_control at session_start", async () => {
		const harness = makePiWithState()
		await fireSessionStart(harness)
		expect(harness.getRegisteredTools().map((tool) => tool.name)).toContain("bash_control")
		expect(harness.getActiveToolNames()).toContain("bash_control")
		expect(harness.setActiveTools).not.toHaveBeenCalled()
	})

	it("background handles never change the advertised tool set", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const a = spawnRunning("first-proc")
		await startTrackedSession(harness, a)
		const transitionsAtStart = harness.setActiveTools.mock.calls.length
		expect(transitionsAtStart).toBe(0)

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
		expect(harness.setActiveTools.mock.calls.length).toBe(transitionsAtStart)
	})

	it("keeps bash_control visible in agent workers (carve-out)", async () => {
		workerState.isWorker = true
		const harness = makePiWithState()
		await fireSessionStart(harness)
		expect(harness.getActiveToolNames()).toContain("bash_control")
		workerState.isWorker = false
	})

	it("a re-entered session_start keeps bash_control visible", async () => {
		workerState.isWorker = false
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		expect(harness.getActiveToolNames()).toContain("bash_control")

		// Resume/fork re-enters session_start; the static tool surface stays visible.
		const transitions = harness.setActiveTools.mock.calls.length
		await fireSessionStart(harness)
		expect(harness.getActiveToolNames()).toContain("bash_control")
		expect(harness.setActiveTools.mock.calls.length).toBe(transitions)
	})
})

describe("unattended exits", () => {
	it("delivers the terminal result immediately with triggerTurn followUp and removes the handle", async () => {
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
		expect(exits[0]?.options?.triggerTurn).toBe(true)
		expect(exits[0]?.options?.deliverAs).toBe("followUp")
		expect(registry.getEntry(handle)).toBeUndefined()
		expect(coordinator.handles()).not.toContain(handle)
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

	it("a filtered inspection claims only the handles it may collect; unfiltered exits notify normally", async () => {
		const harness = makePiWithState()
		const selected = spawnRunning("selected-proc")
		const other = spawnRunning("other-proc")
		await startTrackedSession(harness, selected)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: {},
			content: [],
			isError: false,
			details: { handle: other, handoff: true, exited: false },
		})

		// A filtered inspection is in flight: it claims only the selected
		// handle (its sweep covers just the filter).
		await fireToolExecutionStart(harness, "filtered-call", "bash_control", {
			wait: false,
			handles: [selected],
		})

		// The UNFILTERED handle exits while the call is in flight: its exit
		// watcher was not silenced by the filtered call, so the unattended
		// notification fires immediately (not deferred to the call's
		// tool_execution_end backstop).
		await exitProcess(other, 0)
		await flush()
		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		expect(exits).toHaveLength(1)
		const exitText = exits[0]?.content[0]?.text ?? ""
		// The notification carries the unfiltered handle's terminal result…
		expect(exitText).toContain(` handle: ${other}`)
		expect(exitText).toContain("exited (exit code 0)")

		// The selected handle is untouched by the notification and still
		// owned by the filtered call.
		expect(registry.getEntry(selected)?.state).toBe("running")
		await fireToolExecutionEnd(harness, "filtered-call", "bash_control")
		await flush()
		// No further notification: the call released the claim without an
		// exit to deliver.
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)
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
	it("sends at most one steer per session for write/execute tools", async () => {
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

	it("warns once per session: later turns, heartbeats, and cohort changes do not repeat it", async () => {
		// Reviewer check "Concurrency warning cadence": one advisory per
		// session — a write per turn across three turns, a trivial Bash
		// heartbeat, and an added background handle never repeat it.
		const harness = makePiWithState()
		const a = spawnRunning("cadence-a")
		await startTrackedSession(harness, a)

		for (let turn = 1; turn <= 3; turn++) {
			await fireTurnStart(harness)
			// A read first: reads neither issue nor consume the advisory.
			await fireToolCall(harness, "read", { path: "x" })
			await fireToolCall(harness, "edit", { file: `f${turn}` })
		}
		// A trivial Bash heartbeat after the advisory is still an execute call.
		await fireToolCall(harness, "bash", { command: "echo heartbeat" })
		// Another background handle joins the cohort.
		const b = spawnRunning("cadence-b")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c9",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: b, handoff: true, exited: false },
		})
		await fireToolCall(harness, "edit", { file: "f4" })

		const steers = followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)
		expect(steers).toHaveLength(1)
		expect(steers[0]?.content[0]?.text ?? "").toContain(a)

		// A new session can issue its own first advisory again.
		await fireSessionStart(harness)
		const c = spawnRunning("cadence-c")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c10",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: c, handoff: true, exited: false },
		})
		await fireToolCall(harness, "edit", { file: "f5" })
		expect(followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)).toHaveLength(2)
	})

	it("never asserts a stale tracked handle is running in the advisory", async () => {
		const harness = makePiWithState()
		const stale = spawnRunning("stale-only")
		await startTrackedSession(harness, stale)
		// The registry entry disappears behind the extension's back (the
		// failed tool_result chain the reviewer observed): tracking keeps the
		// handle, but no advisory may claim it is running.
		await registry.remove(stale)
		await fireToolCall(harness, "edit", { file: "x" })
		expect(followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)).toHaveLength(0)
	})
})

describe("completion continuation", () => {
	/** Fire the message_end event for a queued custom message (consumption). */
	async function consumeFollowUp(
		harness: ReturnType<typeof createExtensionApi>,
		sent: SentMessage,
	): Promise<Array<{ message: Record<string, unknown> } | undefined>> {
		const results = await harness.emit(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: sent.customType,
					content: sent.content,
					display: sent.display,
					details: sent.details,
					timestamp: 0,
				},
			},
			ctx,
		)
		return results.filter(
			(r): r is { message: Record<string, unknown> } =>
				typeof r === "object" && r !== null && "message" in (r as Record<string, unknown>),
		)
	}

	it("emits a consolidated continuation on every unresolved completion attempt", async () => {
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

		// While the first reminder is still queued (unconsumed), a second
		// attempt is suppressed — at most one outstanding reminder per session.
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)

		// The loop drains the queued reminder (message_end) before the run
		// settles — with the reminder consumed, a new genuinely unresolved
		// attempt queues a fresh continuation (no lifetime suppression).
		const consumed = await consumeFollowUp(harness, guards[0] as SentMessage)
		expect(consumed).toHaveLength(0) // contents unchanged — no replacement
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(2)

		// Resolve one process; the remaining one still requires a disposition.
		// Consume the outstanding reminder first (the loop drains it before
		// the next attempt settles).
		await consumeFollowUp(harness, guards[1] as SentMessage)
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
		await consumeFollowUp(harness, guards[2] as SentMessage)
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

	it("stop through the registered tool clears tracking; no later guidance demands a disposition", async () => {
		// Reviewer row 1 ("Stop clears tracking and completion guidance"),
		// reproduced through the full wiring with the REAL two-second
		// handoff timers: two long commands hand off through the real bash
		// tool execute, both are stopped through the registered bash_control
		// tool, and the chain that failed live (tool_result details →
		// exitedHandles → trackedHandles removal) is asserted end to end.
		const handoffRegistry = createProcessRegistry()
		const handoffCoordinator = createReviewCoordinator({ registry: handoffRegistry })
		const handoffState: BashSessionState = {
			registry: handoffRegistry,
			coordinator: handoffCoordinator,
			limitSeconds: 600,
			cwd: "/test/cwd",
		}
		currentState = handoffState
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const bashTool = createBackgroundBashToolDefinition("/test/cwd", {
			state: handoffState,
			operations: ops,
		})
		const startedAt = Date.now()
		const [first, second] = await Promise.all([
			bashTool.execute("bash-1", { command: "sleep-long-first" }, undefined, undefined, undefined as never),
			bashTool.execute("bash-2", { command: "sleep-long-second" }, undefined, undefined, undefined as never),
		])
		// Both commands were still running at the real one-time handoff
		// deadline (2s), not before it.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900)
		expect(first.details?.handoff).toBe(true)
		expect(second.details?.handoff).toBe(true)
		const firstHandle = first.details?.handle as string
		const secondHandle = second.details?.handle as string
		// The real tool_result events carrying the REAL result details.
		for (const [id, result] of [
			["bash-1", first],
			["bash-2", second],
		] as const) {
			await fireToolResult(harness, {
				type: "tool_result",
				toolName: "bash",
				toolCallId: id,
				input: { command: "long" },
				content: result.content,
				isError: false,
				details: result.details,
			})
		}

		// Stop both through the registered control tool (full wiring:
		// tool_execution_start → execute → tool_execution_end → tool_result
		// with the REAL result details).
		const controlTool = createBashControlToolDefinition(() => handoffState)
		const stopArgs = { stop_handles: [firstHandle, secondHandle] }
		await fireToolExecutionStart(harness, "stop-call", "bash_control", stopArgs)
		const stopResult = await controlTool.execute(
			"stop-call",
			stopArgs as never,
			undefined,
			undefined,
			undefined as never,
		)
		await fireToolExecutionEnd(harness, "stop-call", "bash_control")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "stop-call",
			input: stopArgs,
			content: stopResult.content,
			isError: false,
			details: stopResult.details,
		})

		// Stop results identify the exited handles; registry entries are
		// removed; the cohort is empty.
		expect(stopResult.details.exitedHandles).toEqual([firstHandle, secondHandle])
		expect(handoffRegistry.getEntry(firstHandle)).toBeUndefined()
		expect(handoffRegistry.getEntry(secondHandle)).toBeUndefined()
		expect(handoffCoordinator.handles()).toEqual([])

		// No subsequent guidance demands waiting for or stopping those
		// handles — eight completion attempts, zero guards.
		for (let i = 0; i < 8; i++) {
			await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		}
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)

		// Both sanctioned dispositions report nothing left to do.
		const inspect = await controlTool.execute(
			"insp-call",
			{ wait: false } as never,
			undefined,
			undefined,
			undefined as never,
		)
		expect((inspect.content[0] as { text?: string }).text ?? "").toContain("No background processes remain running")
		const wait = await controlTool.execute(
			"wait-call",
			{ wait: true } as never,
			undefined,
			undefined,
			undefined as never,
		)
		expect((wait.content[0] as { text?: string }).text ?? "").toContain(
			"No background processes remain running; nothing to wait for",
		)
		expect(wait.details.event).toBe("empty")
		expect(wait.details.waitedSeconds ?? 0).toBeLessThan(1)
		await handoffRegistry.shutdown()
	})

	it("replaces a stale queued guard at consumption and never lets it demand dispositions", async () => {
		// Reviewer row 2 ("Queued guard backlog"), transcript-derived: older
		// follow-ups accumulate ahead of the guard, completion attempts queue
		// a guard while a process runs, all processes are stopped before the
		// guard is consumed, then the queue drains. At most one guard is
		// outstanding; obsolete guidance is suppressed when consumed;
		// unrelated queued messages survive; completion settles.
		const harness = makePiWithState()
		const a = spawnRunning("backlog-a")
		const b = spawnRunning("backlog-b")
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

		// Older queued messages ahead of the guard: a concurrency advisory
		// (steering) and an unattended-exit notification (follow-up).
		await fireToolCall(harness, "edit", { file: "x" })
		await exitProcess(a, 0)
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)).toHaveLength(1)
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(1)

		// Completion attempts while b still runs: exactly one guard queues.
		for (let i = 0; i < 3; i++) {
			await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		}
		const guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)
		expect(guards[0]?.content[0]?.text ?? "").toContain("Still running")
		expect(guards[0]?.content[0]?.text ?? "").toContain(b)

		// All processes are stopped BEFORE the guard is consumed.
		const controlTool = createBashControlToolDefinition(() => state)
		const stopArgs = { stop_handles: [b] }
		await fireToolExecutionStart(harness, "stop-call", "bash_control", stopArgs)
		const stopResult = await controlTool.execute(
			"stop-call",
			stopArgs as never,
			undefined,
			undefined,
			undefined as never,
		)
		await fireToolExecutionEnd(harness, "stop-call", "bash_control")
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "stop-call",
			input: stopArgs,
			content: stopResult.content,
			isError: false,
			details: stopResult.details,
		})
		expect(stopResult.details.exitedHandles).toEqual([b])

		// Drain the queue in order: the older advisory and the exit
		// notification pass through untouched (no replacement)…
		const steer = followUps(harness, BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE)[0] as SentMessage
		const exitMsg = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)[0] as SentMessage
		expect(await consumeFollowUp(harness, steer)).toHaveLength(0)
		expect(await consumeFollowUp(harness, exitMsg)).toHaveLength(0)
		// …and the stale guard is REPLACED with a suppression note — it can
		// no longer demand a disposition for the stopped handle.
		const replacements = await consumeFollowUp(harness, guards[0] as SentMessage)
		expect(replacements).toHaveLength(1)
		const replacedText = (replacements[0]?.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? ""
		expect(replacedText).toContain("suppressed")
		expect(replacedText).not.toContain("Still running")
		expect(replacedText).not.toContain(b)

		// The older queued messages survived (still the original texts).
		expect((steer.content[0]?.text ?? "").length).toBeGreaterThan(0)
		expect((exitMsg.content[0]?.text ?? "").length).toBeGreaterThan(0)

		// Completion settles without repeated demands: further attempts
		// produce no new guards.
		for (let i = 0; i < 8; i++) {
			await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		}
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(1)
	})

	it("classifies a tracked handle whose registry entry is gone as resolved, never running", async () => {
		// Reviewer row 3 ("Missing registry entry", without a retained
		// outcome): the failed live chain left a stopped handle in tracking
		// with no registry entry — the guard must drop it, never list it as
		// "Still running".
		const harness = makePiWithState()
		const ghost = spawnRunning("ghost")
		await startTrackedSession(harness, ghost)
		await registry.remove(ghost)

		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("classifies a retained terminal outcome as pending delivery, never running", async () => {
		// Reviewer row 3 ("Missing registry entry", with a retained terminal
		// outcome on #1360: a registry entry in a terminal state whose
		// result was not collected yet, claimed by an in-flight call so its
		// watcher stays silent): the guard demands its delivery as
		// "results not yet delivered", never as running.
		const harness = makePiWithState()
		const dead = spawnRunning("dead-walk")
		await startTrackedSession(harness, dead)
		// An in-flight wait claims the exit, then the process is killed —
		// the watcher stays silent and the registry retains the terminal
		// entry with its result uncollected.
		await fireToolExecutionStart(harness, "call-y", "bash_control", { wait: true })
		await registry.kill(dead)
		expect(registry.getEntry(dead)?.state).not.toBe("running")

		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		const guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)
		const text = guards[0]?.content[0]?.text ?? ""
		expect(text).toContain("Exited, results not yet delivered")
		expect(text).toContain(dead)
		expect(text).not.toContain("Still running")

		// Cleanup: end the owning call (its backstop delivers the exit).
		await fireToolExecutionEnd(harness, "call-y", "bash_control", true)
		await flush()
	})
})

describe("terminal display metadata", () => {
	it("restores thrown-result details through the supported result hook and then clears them", async () => {
		const pi = createExtensionApi()
		bashControlExtension(pi.api, { getState: () => undefined })
		await pi.emit("session_start", {})
		const details = {
			handle: "h1",
			exited: true,
			exitCode: 7,
			display: { handle: "h1", command: "exit 7", state: "exited", exitCode: 7 },
		}
		await pi.emit("tool_execution_update", {
			toolName: "bash",
			toolCallId: "failed",
			partialResult: { content: [{ type: "text", text: "last line" }], details },
		})
		const event = {
			toolName: "bash",
			toolCallId: "failed",
			content: [{ type: "text", text: "Command exited with code 7" }],
			details: {},
			isError: true,
		}
		const results = await pi.emit("tool_result", event)
		expect(results).toContainEqual({ details })
		expect(event.isError).toBe(true)
		expect(event.content[0].text).toBe("Command exited with code 7")
		expect(await pi.emit("tool_result", event)).toEqual([undefined])
	})

	it("drops unconsumed metadata on session replacement", async () => {
		const pi = createExtensionApi()
		bashControlExtension(pi.api, { getState: () => undefined })
		await pi.emit("tool_execution_update", {
			toolName: "bash",
			toolCallId: "old",
			partialResult: { details: { handle: "h1", exited: true, display: { state: "exited" } } },
		})
		await pi.emit("session_start", {})
		expect(await pi.emit("tool_result", { toolName: "bash", toolCallId: "old", details: {}, isError: true })).toEqual([
			undefined,
		])
	})
})
