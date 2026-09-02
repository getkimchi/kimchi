/**
 * Integration tests for bashControlExtension: background cohorts are
 * tracked for lifecycle notices and concurrency context, but NEVER block
 * other tool calls. Unattended exits are delivered immediately exactly
 * once (owned exits route into the active bash_control result); due
 * cohort reviews piggyback on active turns or wake idle agents and fold
 * in any undelivered terminal results; a normal completion with tracked
 * handles emits one bounded follow-up per stable handle set.
 *
 * Exercises the full event wiring against the shared fake ExtensionAPI
 * (`__mocks__/extension-api.ts`) plus a real registry/coordinator driven
 * by a fake BashOperations.
 */
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import bashControlExtension, {
	BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE,
	BASH_BACKGROUND_CONCURRENCY_MESSAGE_TYPE,
	BASH_BACKGROUND_EXIT_MESSAGE_TYPE,
	BASH_BACKGROUND_REVIEW_MESSAGE_TYPE,
} from "./bash-control-extension.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"

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
	coordinator = createReviewCoordinator({ registry, handoffSeconds: 1, reviewIntervalSeconds: 60 })
	state = { registry, coordinator, limitSeconds: 600, cwd: "/test/cwd" }
	currentState = state
})

afterEach(async () => {
	await registry.shutdown()
})

function spawnRunning(command = "long-running", cwd = "/test/cwd"): string {
	const handle = registry.spawn(ops, command, cwd, undefined, { limitSeconds: 600 })
	coordinator.handleSpawned(handle)
	return handle
}

// ─── Event helpers ────────────────────────────────────────────────────────────

const ctx = {} as ExtensionContext

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
	it("registers the bash_control tool and installs the review deliverer", async () => {
		const harness = makePiWithState()
		await fireSessionStart(harness)
		const toolNames = harness.registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name)
		expect(toolNames).toContain("bash_control")
		expect(state.deliverReview).toBeDefined()
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

	it("delivers two same-tick exits without losing either", async () => {
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

		await ops.exitMatching("first-proc", 0)
		await ops.exitMatching("second-proc", 0)
		await flush()

		const exits = followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)
		// One delivery per exit is the (spec-permitted) no-debounce shape:
		// what matters is that NEITHER exit is lost.
		const texts = exits.map((m) => m.content[0]?.text ?? "")
		expect(texts.some((t) => t.includes(` handle: ${a}`))).toBe(true)
		expect(texts.some((t) => t.includes(` handle: ${b}`))).toBe(true)
		expect(registry.getEntry(a)).toBeUndefined()
		expect(registry.getEntry(b)).toBeUndefined()
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

describe("cohort review delivery", () => {
	it("wakes an idle agent with triggerTurn and delivers facts + unseen output once", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning("builder")
		await startTrackedSession(harness, handle)
		ops.emitMatching("builder", "review-output\n")

		await state.deliverReview?.()
		await flush()

		const reviews = followUps(harness, BASH_BACKGROUND_REVIEW_MESSAGE_TYPE)
		expect(reviews).toHaveLength(1)
		expect(reviews[0]?.options?.triggerTurn).toBe(true)
		expect(reviews[0]?.options?.deliverAs).toBe("followUp")
		const text = reviews[0]?.content[0]?.text ?? ""
		expect(text).toContain("Scheduled cohort review of 1")
		expect(text).toContain(` handle: ${handle}`)
		expect(text).toContain("review-output")
		// Cursor advanced: a second review sees no new output.
		await state.deliverReview?.()
		await flush()
		const text2 = followUps(harness, BASH_BACKGROUND_REVIEW_MESSAGE_TYPE)[1]?.content[0]?.text ?? ""
		expect(text2).toContain("no new output observed")
		expect(text2).not.toContain("review-output")
	})

	it("piggybacks on an active turn without triggerTurn", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await fireTurnStart(harness)

		await state.deliverReview?.()
		await flush()

		const reviews = followUps(harness, BASH_BACKGROUND_REVIEW_MESSAGE_TYPE)
		expect(reviews).toHaveLength(1)
		expect(reviews[0]?.options?.triggerTurn).toBeUndefined()
		expect(reviews[0]?.options?.deliverAs).toBe("followUp")
	})

	it("folds undelivered terminal results into the review and cleans them up", async () => {
		const harness = makePiWithState()
		const running = spawnRunning("stayer")
		const dead = spawnRunning("goner")
		await startTrackedSession(harness, running)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: dead, handoff: true, exited: false },
		})
		ops.emitMatching("goner", "goner-final\n")

		// Kill without delivering: killInternal flips the entry terminal
		// synchronously, while the exit watcher's promise chain has NOT yet
		// delivered when deliverReview runs — the review must claim the
		// terminal result itself. (First collector wins: no double delivery.)
		void registry.kill(dead)
		await state.deliverReview?.()
		await flush()

		const reviews = followUps(harness, BASH_BACKGROUND_REVIEW_MESSAGE_TYPE)
		expect(reviews).toHaveLength(1)
		const text = reviews[0]?.content[0]?.text ?? ""
		expect(text).toContain(` handle: ${dead}`)
		expect(text).toContain("stopped on request")
		expect(text).toContain("goner-final")
		expect(text).toContain(` handle: ${running}`)
		expect(registry.getEntry(dead)).toBeUndefined()
		expect(coordinator.handles()).not.toContain(dead)
		// The exit watcher, when it eventually runs, must NOT deliver a second
		// terminal result for the same handle.
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("leaves terminal results claimed by an in-flight bash_control call to that call", async () => {
		const harness = makePiWithState()
		const running = spawnRunning("stayer")
		const dead = spawnRunning("goner")
		await startTrackedSession(harness, running)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "long" },
			content: [],
			isError: false,
			details: { handle: dead, handoff: true, exited: false },
		})
		// The wait claims the whole cohort BEFORE it awaits.
		await fireToolExecutionStart(harness, "call-w", "bash_control", { wait: true })
		// Terminal but undelivered at review time (same construction as the
		// fold-in test): the claim must keep the review's hands off it.
		void registry.kill(dead)

		await state.deliverReview?.()
		await flush()

		const reviews = followUps(harness, BASH_BACKGROUND_REVIEW_MESSAGE_TYPE)
		expect(reviews).toHaveLength(1)
		const text = reviews[0]?.content[0]?.text ?? ""
		expect(text).not.toContain(` handle: ${dead}`)
		expect(text).toContain(` handle: ${running}`)
		// The handle stays tracked for the owning call's consolidated result.
		expect(registry.getEntry(dead)).toBeDefined()
		expect(coordinator.handles()).toContain(dead)

		// Cleanup: simulate the owning call delivering it.
		coordinator.handleRemoved(dead)
		await registry.remove(dead)
		await fireToolResult(harness, {
			type: "tool_result",
			toolName: "bash_control",
			toolCallId: "call-w",
			input: { wait: true },
			content: [],
			isError: false,
			details: { exitedHandles: [dead] },
		})
		await fireToolExecutionEnd(harness, "call-w", "bash_control")
		await flush()
		expect(followUps(harness, BASH_BACKGROUND_EXIT_MESSAGE_TYPE)).toHaveLength(0)
	})

	it("marks the coordinator review as delivered after delivery", async () => {
		const harness = makePiWithState()
		const handle = spawnRunning()
		await startTrackedSession(harness, handle)
		await state.deliverReview?.()
		await flush()
		expect(coordinator.hasPendingReview()).toBe(false)
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

describe("completion guard", () => {
	it("emits one consolidated follow-up per stable handle set", async () => {
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
		const guards = followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)
		expect(guards).toHaveLength(1)
		const text = guards[0]?.content[0]?.text ?? ""
		expect(text).toContain(a)
		expect(text).toContain(b)
		expect(text).toContain("wait: true")
		expect(text).toContain("stop_handles")

		// Same stable set: no repeat.
		await fireTurnEnd(harness, { role: "assistant", stopReason: "stop" })
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(1)
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
		// All exits already delivered; nothing left tracked → no guard.
		expect(followUps(harness, BASH_BACKGROUND_COMPLETION_MESSAGE_TYPE)).toHaveLength(0)
	})
})
