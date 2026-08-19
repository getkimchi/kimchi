import { randomUUID } from "node:crypto"
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "../todos/constants.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION } from "../todos/types.js"
import {
	GET_GOAL_TOOL_NAME,
	GOAL_CONTEXT_MESSAGE_TYPE,
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
import { GOAL_EVENTS } from "./domain-events.js"
import { evaluateGoal } from "./evaluator.js"
import goalExtension from "./index.js"
import { DEFAULT_GOAL_SETTINGS, getGoalSettings } from "./settings.js"
import type { GoalJournalEntry, SessionGoal } from "./types.js"

vi.mock("./evaluator.js", () => ({ evaluateGoal: vi.fn() }))
vi.mock("./settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./settings.js")>()
	return { ...actual, getGoalSettings: vi.fn() }
})

const evaluateGoalMock = vi.mocked(evaluateGoal)
const goalSettingsMock = vi.mocked(getGoalSettings)
const EVALUATOR_USAGE = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	costUsd: 0.33,
}

type ExtensionHandler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>
type CommandConfig = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null
}
type ToolConfig = {
	name: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>
		details: Record<string, unknown>
		terminate?: boolean
	}>
}

describe("goal extension", () => {
	let harness: ReturnType<typeof createHarness>

	beforeEach(async () => {
		evaluateGoalMock.mockResolvedValue({
			verdict: "continue",
			reason: "More work is required.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS })
		harness = createHarness()
		await harness.fire("session_start", { type: "session_start", reason: "new" })
	})

	afterEach(async () => {
		await harness.fire("session_shutdown", { type: "session_shutdown" })
		vi.restoreAllMocks()
	})

	it("registers the commands, completions, tools, and empty-state behavior", async () => {
		expect([...harness.commands.keys()]).toEqual(["goal"])
		expect([...harness.tools.keys()]).toEqual([...GOAL_TOOL_NAMES])
		expect(
			harness.commands
				.get("goal")
				?.getArgumentCompletions?.("re")
				?.map((entry) => entry.value),
		).toEqual(["resume"])
		expect(harness.commands.get("goal")?.getArgumentCompletions?.("ed")?.[0]).toMatchObject({
			value: "edit ",
			label: "edit",
		})

		await harness.command("")
		expect(harness.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("No goal is currently set"), "info")

		const result = await harness.tool(GET_GOAL_TOOL_NAME, {})
		expect(result.details.goal).toBeNull()
	})

	it("publishes no status when no goal exists", async () => {
		expect(harness.ui.setStatus).toHaveBeenCalledWith("goal", undefined)
		expect(harness.ui.setStatus).not.toHaveBeenCalledWith("goal", expect.any(String))
	})

	it("creates a goal, persists it, and confirms unfinished replacement", async () => {
		await harness.command("ship feature A")
		const first = harness.currentGoal()

		expect(first).toMatchObject({ revision: 1, objective: "ship feature A", status: "active" })
		expect(harness.events.emit).toHaveBeenCalledWith(
			GOAL_EVENTS.STARTED,
			expect.objectContaining({ goalId: first?.id, revision: 1, status: "active" }),
		)
		expect(harness.events.emit.mock.lastCall?.[1]).not.toHaveProperty("objective")
		expect(harness.appendEntry).toHaveBeenCalledWith(
			GOAL_CUSTOM_ENTRY_TYPE,
			expect.objectContaining({ op: "put", goal: expect.objectContaining({ id: first?.id }) }),
		)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ display: false, details: expect.objectContaining({ revision: 1 }) }),
			{ triggerTurn: true, deliverAs: "steer" },
		)
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("leave the settled list visible")
		expect(harness.sendMessage.mock.lastCall?.[0].content).not.toContain("Before other tools")

		harness.ui.confirm.mockResolvedValueOnce(false)
		await harness.command("ship feature B")
		expect(harness.currentGoal()?.id).toBe(first?.id)

		harness.ui.confirm.mockResolvedValueOnce(true)
		await harness.command("ship feature B")
		const replacement = harness.currentGoal()
		expect(replacement).toMatchObject({ revision: 1, objective: "ship feature B", status: "active" })
		expect(replacement?.id).not.toBe(first?.id)
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.REPLACED,
			expect.objectContaining({ goalId: replacement?.id, revision: 1, status: "active" }),
		)
	})

	it("waits for a headless goal turn before resolving the command", async () => {
		const headlessHarness = createHarness({ hasUI: false })

		let resolved = false
		const command = headlessHarness.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headlessHarness.sendMessage).toHaveBeenCalledOnce())
		expect(resolved).toBe(false)
		expect(headlessHarness.waitForIdle).not.toHaveBeenCalled()

		await settleGoal(headlessHarness, "unavailable")
		await command
		expect(resolved).toBe(true)
	})

	it("does not block a headless command when no goal turn can be queued", async () => {
		const headlessHarness = createHarness({ hasUI: false })
		headlessHarness.setActiveTools([])

		await headlessHarness.command("ship feature A")
		expect(headlessHarness.sendMessage).not.toHaveBeenCalled()
		expect(headlessHarness.currentGoal()).toMatchObject({ status: "active" })
	})

	it("resolves a headless waiter when the goal tools go away mid-evaluation", async () => {
		const headless = createHarness({ hasUI: false })

		let resolved = false
		const command = headless.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())
		expect(resolved).toBe(false)

		// The pre-evaluator canEvaluateGoal check passes here (tools are still
		// available), so the evaluator call proceeds and only the post-evaluator
		// twin ever sees the tools go away.
		const { release, settled } = await holdEvaluation(headless)
		expect(resolved).toBe(false)

		headless.setActiveTools([])
		release({ verdict: "continue", reason: "More work is required.", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await settled

		const TIMED_OUT = Symbol("timed out")
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
			timer = setTimeout(() => resolve(TIMED_OUT), 300)
		})
		const winner = await Promise.race([command, timeout])
		if (timer) clearTimeout(timer)

		// If this regresses, the post-evaluator canEvaluateGoal failure never
		// resolves the waiter (unlike its pre-evaluator twin), and the headless
		// command hangs forever instead of the race above timing out.
		expect(winner).not.toBe(TIMED_OUT)
		expect(resolved).toBe(true)
	})

	it("starts replacement accounting with its own turn", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("first")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })

		dateNow.mockReturnValue(61_000)
		await harness.command("second")
		expect(harness.currentGoal()).toMatchObject({ objective: "second", timeUsedMs: 0 })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal active · <1m · 0 tokens")

		dateNow.mockReturnValue(121_000)
		await harness.fire("turn_end", terminalTurn())
		expect(harness.currentGoal()).toMatchObject({ timeUsedMs: 0 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 121_000 })
		dateNow.mockReturnValue(181_000)
		await harness.fire("turn_end", terminalTurn())
		expect(harness.currentGoal()).toMatchObject({ timeUsedMs: 60_000 })
	})

	it("replaces a complete goal without confirmation", async () => {
		await harness.command("first")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		await settleGoal(harness, "met")
		harness.ui.confirm.mockClear()

		await harness.command("second")

		expect(harness.ui.confirm).not.toHaveBeenCalled()
		expect(harness.currentGoal()).toMatchObject({ objective: "second", revision: 1, status: "active" })
	})

	it("shows running feedback and reports final elapsed time and tokens", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("ship it")
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal active · <1m · 0 tokens")
		expect(harness.ui.setWidget).not.toHaveBeenCalled()

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal running · <1m · 0 tokens")
		dateNow.mockReturnValue(3_500)
		await harness.fire("turn_end", terminalTurn("stop", { input: 1_200, output: 300 }))
		expect(harness.currentGoal()).toMatchObject({ tokensUsed: 1_500, timeUsedMs: 2_500 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 3_500 })
		dateNow.mockReturnValue(4_500)
		await completeVisibleTodo(harness)
		const goal = requireGoal(harness.currentGoal())
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: goal.id,
			revision: goal.revision,
			status: "complete",
			completion_confidence: "proven",
		})
		await harness.fire("turn_end", terminalTurn("stop", { input: 200, output: 50 }))
		await settleGoal(harness, "met")

		expect(harness.currentGoal()).toMatchObject({
			status: "complete",
			completionConfidence: "proven",
			tokensUsed: 1_750,
			timeUsedMs: 3_500,
		})
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal complete.", "info")
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", undefined)
	})

	it("treats missing usage fields as zero", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.fire("turn_end", terminalTurn("stop", { input: 25 }))

		expect(harness.currentGoal()?.tokensUsed).toBe(25)
	})

	it("allows work tools but requires visible settled todos before ending every goal revision", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })

		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", { type: "tool_call", toolName: GET_GOAL_TOOL_NAME, input: {} }),
		).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("visible tactical todo") })

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Implement the goal", status: "in_progress" }],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("settle every item") })

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Implement the goal", status: "completed" }],
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "clear_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [],
					updatedAt: "2026-08-03T00:00:03.000Z",
				},
			},
		})
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("without clearing") })

		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })
		await harness.command("another session goal")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })

		await harness.command("edit changed objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })
	})

	it("ignores todo results from a non-visible scope", async () => {
		await harness.command("ship it")
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					scope: { kind: "ferment-step", phaseId: "phase-a", stepId: "step-a" },
					todos: [{ content: "Hidden work", status: "in_progress" }],
				},
			},
		})

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })
	})

	it("ignores malformed todo result scopes", async () => {
		await harness.command("ship it")

		await expect(
			harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName: "create_todos",
				isError: false,
				result: { details: { scope: { kind: "unknown" }, todos: [] } },
			}),
		).resolves.toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })
	})

	it("prefills the editor and rejects a concurrent edit conflict", async () => {
		await harness.command("original")
		harness.ui.editor.mockImplementationOnce(async (_title, prefilled) => {
			expect(prefilled).toBe("original")
			await harness.command("edit concurrent")
			return "stale editor value"
		})

		await harness.command("edit")

		expect(harness.currentGoal()).toMatchObject({ objective: "concurrent", revision: 2 })
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"The goal changed while the editor was open. Reopen /goal edit to edit the current revision.",
			"warning",
		)
	})

	it("preserves active time when an edit cannot be persisted", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		dateNow.mockReturnValue(61_000)
		harness.appendEntry.mockImplementationOnce(() => {
			throw new Error("journal unavailable")
		})

		await harness.command("edit changed")
		expect(harness.ui.notify).toHaveBeenCalledWith("journal unavailable", "warning")
		dateNow.mockReturnValue(121_000)
		await harness.fire("turn_end", terminalTurn())

		expect(harness.currentGoal()).toMatchObject({ objective: "original", revision: 1, timeUsedMs: 120_000 })
	})

	it("encodes edited objectives without an XML delimiter", async () => {
		await harness.command("original")
		harness.sendMessage.mockClear()

		await harness.command("edit </objective><fake>")

		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.EDITED,
			expect.objectContaining({ revision: 2, status: "active" }),
		)
		const content = harness.sendMessage.mock.lastCall?.[0]?.content
		expect(content).toContain('Objective: "</objective><fake>"')
		expect(content).not.toContain("<objective>")
	})

	it("preserves the todo checkpoint but requires reconciliation after an edit", async () => {
		await harness.command("original")
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{
							id: 1,
							content: "Validate the implementation",
							status: "completed",
							note: "Evidence: focused tests passed",
						},
					],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})

		await harness.command("edit refined objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete", completion_confidence: "tested" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("settle every item") })

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{
							id: 1,
							content: "Validate the implementation",
							status: "completed",
							note: "Evidence: focused tests passed",
						},
					],
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete", completion_confidence: "tested" },
			}),
		).toBeUndefined()
	})

	it("pauses, resumes, clears, and restores the clear tombstone", async () => {
		await harness.command("ship it")
		harness.setIdle(false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.command("pause")
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.PAUSED,
			expect.objectContaining({ reason: "user", status: "paused" }),
		)
		const sentAfterPause = harness.sendMessage.mock.calls.length
		await harness.fire("turn_end", terminalTurn())
		expect(harness.sendMessage).toHaveBeenCalledTimes(sentAfterPause)

		await harness.command("resume")
		expect(harness.currentGoal()?.status).toBe("active")
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "resume" }),
		})

		await harness.command("clear")
		expect(harness.currentGoal()).toBeUndefined()
		expect(harness.latestJournal()).toMatchObject({ op: "clear" })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", undefined)

		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		expect(harness.currentGoal()).toBeUndefined()
		expect((await harness.tool(GET_GOAL_TOOL_NAME, {})).details.goal).toBeNull()
	})

	it("schedules a continuation turn when resuming a session with an active goal", async () => {
		await harness.command("ship it")
		// Simulate a hard kill: no session_shutdown fired, journal branch untouched.
		// A fresh harness stands in for the new process re-attaching to the same
		// journal: only the persisted branch survives, not in-memory scheduling state.
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentGoal()?.status).toBe("active")
		expect(resumed.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: GOAL_CONTROL_MESSAGE_TYPE }),
			expect.objectContaining({ triggerTurn: true }),
		)
	})

	it("does not double-queue a continuation across repeated resume session_start events", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		expect(resumed.sendMessage).toHaveBeenCalledTimes(1)

		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		expect(resumed.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not schedule a continuation turn when resuming a non-active goal", async () => {
		await harness.command("ship it")
		harness.setIdle(false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.command("pause")
		expect(harness.currentGoal()?.status).toBe("paused")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentGoal()?.status).toBe("paused")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

	it("does not schedule a continuation turn on resume when a user message is already pending", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		resumed.setPending(true)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentGoal()?.status).toBe("active")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

	// The resume kick fires from a deferred timer, not synchronously during
	// session_start (see index.ts): an embedder such as print mode awaits
	// session_start's dispatch, in which hasPendingMessages() is always false
	// (prompt()/steer()/followUp() haven't run yet), and then immediately
	// calls session.prompt() with its own message. Sending the continuation
	// synchronously there raced that prompt for the streaming slot and could
	// win it, crashing the incoming prompt with "Agent is already
	// processing". Re-checking busyness with ctx.isIdle() (via goalIsBusy) at
	// the deferred kick lets an incoming prompt -- which sets isStreaming
	// before the timer fires -- stand the kick down instead of racing it.
	it("does not schedule a continuation turn on resume when the session is already busy", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		resumed.setIdle(false)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentGoal()?.status).toBe("active")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

	// Pins the actual race fix: the kick must not be sent synchronously while
	// session_start is still dispatching (that is what let it beat an
	// embedder's incoming prompt to the streaming slot). It should only be
	// sent once the deferred timer fires.
	it("does not send the resume kick synchronously during session_start dispatch", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)

		vi.useFakeTimers()
		try {
			const firePromise = resumed.fire("session_start", { type: "session_start", reason: "resume" })
			expect(resumed.sendMessage).not.toHaveBeenCalled()

			await vi.runAllTimersAsync()
			await firePromise

			expect(resumed.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: GOAL_CONTROL_MESSAGE_TYPE }),
				expect.objectContaining({ triggerTurn: true }),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("uses the active turn revision internally for model updates", async () => {
		await harness.command("finish without copying protocol metadata")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		const result = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})

		expect(result.content[0].text).toContain("completion claimed")
		expect(result.terminate).toBe(true)
		expect(harness.currentGoal()?.status).toBe("active")
		await settleGoal(harness, "met")
		expect(harness.currentGoal()?.status).toBe("complete")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.COMPLETED,
			expect.objectContaining({ completionConfidence: "tested", status: "complete" }),
		)
	})

	it("labels verification as self-reported while requiring tested or proven", async () => {
		await harness.command("prove it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		const missing = await harness.tool(UPDATE_GOAL_TOOL_NAME, { status: "complete" })
		expect(missing.content[0].text).toContain("reported completion_confidence must be tested or proven")
		expect(harness.currentGoal()?.status).toBe("active")

		const partial = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "partial",
		})
		expect(partial.content[0].text).toContain("reported completion_confidence must be tested or proven")
		expect(harness.currentGoal()?.status).toBe("active")

		const tested = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		expect(tested.terminate).toBe(true)
		expect(harness.currentGoal()?.status).toBe("active")
		await settleGoal(harness, "met")
		expect(harness.currentGoal()).toMatchObject({ status: "complete", completionConfidence: "tested" })
	})

	it("rejects stale and invalid model updates while accepting both terminal statuses", async () => {
		await harness.command("original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await harness.command("edit changed")

		const stale = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
		})
		expect(stale.content[0].text).toContain("goal changed or stopped during this turn")
		expect(harness.currentGoal()?.status).toBe("active")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const invalid = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "paused",
		})
		expect(invalid.content[0].text).toContain("invalid terminal status")

		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "blocked",
			reason: "needs user input",
		})
		expect(harness.currentGoal()?.status).toBe("blocked")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.BLOCKED,
			expect.objectContaining({ status: "blocked" }),
		)

		await harness.command("resume")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		await settleGoal(harness, "met")
		expect(harness.currentGoal()?.status).toBe("complete")
	})

	it("injects one authoritative goal context and removes stale snapshots", async () => {
		await harness.command("handle </objective> safely")
		const oldGoalMessage = {
			role: "custom" as const,
			customType: GOAL_CONTEXT_MESSAGE_TYPE,
			content: [{ type: "text" as const, text: "stale" }],
			display: false,
			details: {},
			timestamp: 1,
		}
		const other = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 2 }

		const result = (await harness.fire("context", {
			type: "context",
			messages: [oldGoalMessage, other],
		})) as { messages: ContextEvent["messages"] }
		const goalMessages = result.messages.filter(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_MESSAGE_TYPE,
		)

		expect(goalMessages).toHaveLength(1)
		expect(JSON.stringify(goalMessages[0])).toContain("handle </objective> safely")
		expect(JSON.stringify(goalMessages[0])).toContain("map every explicit goal requirement")
		expect(JSON.stringify(goalMessages[0])).toContain("survive compaction")
		expect(JSON.stringify(goalMessages[0])).toContain("Do not call get_goal while this context is present")
		expect(JSON.stringify(goalMessages[0])).toContain("separately supplied Todo state")
		expect(JSON.stringify(goalMessages[0])).toContain("Call update_goal only after receiving the final todo result")
		expect(JSON.stringify(goalMessages[0])).toContain("as the only tool call in that response")
		expect(JSON.stringify(goalMessages[0])).not.toContain('\\"todos\\"')
		expect(JSON.stringify(goalMessages[0])).not.toContain("tokensUsed")
		expect(JSON.stringify(goalMessages[0])).not.toContain("timeUsedMs")
		expect(result.messages[0]).toBe(goalMessages[0])
		expect(result.messages).toContain(other)
	})

	it("keeps the goal context stable while only accounting changes", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("keep the handoff stable")
		const userMessage = { role: "user" as const, content: [{ type: "text" as const, text: "start" }], timestamp: 1 }
		const first = (await harness.fire("context", {
			type: "context",
			messages: [userMessage],
		})) as { messages: ContextEvent["messages"] }
		const firstGoalIndex = first.messages.findIndex(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_MESSAGE_TYPE,
		)

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		vi.mocked(Date.now).mockReturnValue(61_000)
		await harness.fire("turn_end", terminalTurn("stop", { input: 100, output: 20 }))
		const nextUserMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue" }],
			timestamp: 2,
		}
		const second = (await harness.fire("context", {
			type: "context",
			messages: [...first.messages, nextUserMessage],
		})) as { messages: ContextEvent["messages"] }

		expect(second.messages[firstGoalIndex]).toEqual(first.messages[firstGoalIndex])
		expect(second.messages).toContain(nextUserMessage)
	})

	it("does not mutate the system prompt", async () => {
		expect(
			await harness.fire("before_agent_start", {
				type: "before_agent_start",
				prompt: "go",
				systemPrompt: "base",
				systemPromptOptions: {},
			}),
		).toBeUndefined()
	})

	it("evaluates at the drained boundary and defers to pending user input", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn())
		expect(harness.sendMessage).not.toHaveBeenCalled()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(continuations(harness)).toHaveLength(1)
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "evaluation", revision: 1 }),
		})
		expect(harness.sendMessage.mock.lastCall?.[1]).toMatchObject({ deliverAs: "followUp" })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		harness.setPending(true)
		harness.sendMessage.mockClear()
		evaluateGoalMock.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(evaluateGoalMock).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not continue when user input arrives during evaluation", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		harness.appendEntry.mockClear()

		const { release, settled } = await holdEvaluation(harness)
		harness.setPending(true)
		release({
			verdict: "continue",
			reason: "More work is required.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled

		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.currentGoal()?.evaluationCount).toBeUndefined()
	})

	it("keeps evaluator met active until the current revision has a completed visible Todo", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await settleGoal(harness, "met")
		expect(harness.currentGoal()).toMatchObject({
			status: "active",
			evaluationCount: 1,
			lastEvaluation: { verdict: "met" },
		})
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("visible, fully completed Todo list")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		harness.appendEntry.mockClear()
		await settleGoal(harness, "met")
		expect(harness.currentGoal()).toMatchObject({ status: "complete", evaluationCount: 2 })
		expect(harness.appendEntry).toHaveBeenCalledTimes(1)
	})

	it("blocks on impossible and preserves the evaluator reason without telemetering it", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		evaluateGoalMock.mockResolvedValueOnce({
			verdict: "impossible",
			reason: "Needs a user-owned credential.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		harness.appendEntry.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentGoal()).toMatchObject({
			status: "blocked",
			lastEvaluation: { verdict: "impossible", reason: "Needs a user-owned credential." },
		})
		expect(harness.events.emit).toHaveBeenCalledWith(
			GOAL_EVENTS.EVALUATED,
			expect.not.objectContaining({ reason: expect.anything() }),
		)
		expect(harness.appendEntry).toHaveBeenCalledTimes(1)
	})

	it("pauses resumably when the evaluator is unavailable", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.appendEntry.mockClear()
		await settleGoal(harness, "unavailable")

		expect(harness.currentGoal()).toMatchObject({
			status: "paused",
			evaluationCount: 1,
			lastEvaluation: { verdict: "unavailable", reason: "No evaluator model is available." },
		})
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal paused: No evaluator model is available.", "warning")
		expect(harness.appendEntry).toHaveBeenCalledTimes(1)
	})

	it("keeps evaluation details out of the transcript and status line", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await settleGoal(harness, "continue")
		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(continuations(harness)).toHaveLength(1)
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal running · <1m · 0 tokens")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		await settleGoal(harness, "impossible")
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal blocked · <1m · 0 tokens")
	})

	it("counts substantive tool use only while the goal is active", async () => {
		await harness.command("ship it")
		await harness.command("pause")

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "call-while-paused",
			isError: false,
			result: {},
		})

		await harness.command("resume")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleGoal(harness, "continue")

		// Work done while paused must not count as progress after the resume.
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress" }),
		)
	})

	it("stalls an agent that keeps claiming completion without new work", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.tool(UPDATE_GOAL_TOOL_NAME, { status: "complete", completion_confidence: "proven" })
			await settleGoal(harness, "continue")
		}

		// A repeated claim is not progress: the stall guard must still fire.
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress" }),
		)
	})

	it("keeps the completion claim across a continue verdict", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_GOAL_TOOL_NAME, { status: "complete", completion_confidence: "proven" })

		await settleGoal(harness, "continue")
		expect(harness.currentGoal()).toMatchObject({ status: "active" })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleGoal(harness, "met")
		expect(harness.currentGoal()).toMatchObject({ status: "complete", completionConfidence: "proven" })
	})

	it("reports each evaluation's own usage rather than the running total", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleGoal(harness, "continue")

		const evaluated = harness.events.emit.mock.calls.filter(([name]) => name === GOAL_EVENTS.EVALUATED)
		expect(evaluated).toHaveLength(2)
		// Summing the events must equal the goal's cumulative evaluator spend.
		for (const [, payload] of evaluated) expect(payload).toMatchObject({ usage: EVALUATOR_USAGE })
		expect(harness.currentGoal()?.evaluatorUsage?.totalTokens).toBe(EVALUATOR_USAGE.totalTokens * 2)
	})

	it("does not label an agent error as an evaluator verdict", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn("error"))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		const content = harness.sendMessage.mock.lastCall?.[0].content
		expect(content).toContain("ended with an error")
		expect(content).not.toContain("Independent completion check")
	})

	it("blocks a headless edit until the goal reaches a terminal state", async () => {
		const headless = createHarness({ hasUI: false })
		const create = headless.command("ship it")
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())

		let editResolved = false
		const edit = headless.command("edit ship it properly").then(() => {
			editResolved = true
		})
		await vi.waitFor(() => expect(headless.currentGoal()?.revision).toBe(2))
		expect(editResolved).toBe(false)

		await settleGoal(headless, "unavailable")
		await Promise.all([create, edit])
		expect(editResolved).toBe(true)
	})

	it("steers the agent when paused while an evaluation is still deciding", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		// The run is already marked inactive when agent_settled fires, so only the
		// in-flight evaluation can tell pause that the goal is still working.
		harness.setIdle(true)

		const { release, settled } = await holdEvaluation(harness)

		await harness.command("pause")
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("paused the Kimchi session goal")

		release({ verdict: "continue", reason: "More work is required.", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await settled
		// The aborted evaluation must not resurrect the paused goal.
		expect(harness.currentGoal()?.status).toBe("paused")
	})

	it("discards an evaluator result for a stale Goal revision", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled } = await holdEvaluation(harness)

		await harness.command("edit new objective")
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled

		expect(harness.currentGoal()).toMatchObject({ revision: 2, objective: "new objective" })
		expect(harness.currentGoal()?.evaluationCount).toBeUndefined()
	})

	it("cancels an in-flight evaluation when the goal is replaced", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		harness.ui.confirm.mockResolvedValueOnce(true)
		await harness.command("new objective")

		expect(signal?.aborted).toBe(true)
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled
	})

	it("cancels an in-flight evaluation when the goal is edited", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		await harness.command("edit new objective")

		expect(signal?.aborted).toBe(true)
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled
	})

	it("aborts an evaluation held across a session_tree rewind that lands on the same goal revision", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		// Journaled like the other replay tests: restoreGoalRuntime rebuilds
		// todoStateFor from branch entries, so the settled Todo has to actually be
		// there for the post-rewind "met" path to be reachable at all.
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the goal", status: "completed" }],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
		])

		const { release, settled, signal } = await holdEvaluation(harness)

		// A rewind landing back on the same goal id/revision: the post-await
		// identity check alone can't tell this apart from a live evaluation.
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })

		expect(signal?.aborted).toBe(true)

		release({
			verdict: "met",
			reason: "All requirements are evidenced.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled

		// The stale "met" verdict must not resurrect and complete a goal whose
		// conversation was just rewound away from.
		expect(harness.currentGoal()?.status).not.toBe("complete")
	})

	it("aborts an in-flight evaluation when session_start switches to a different session", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })

		expect(signal?.aborted).toBe(true)
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled
	})

	it("pauses after three continuation turns without recorded todo progress", async () => {
		await harness.command("keep going")
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Do the work", status: "in_progress", activeForm: "Working" }],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})
		harness.sendMessage.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName: "mark_todo",
				isError: false,
				result: {
					details: {
						schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
						scope: { kind: "global" },
						todos: [
							{
								id: 1,
								content: "Do the work",
								status: "in_progress",
								activeForm: "Working",
								note: `Cosmetic note ${turnIndex}`,
							},
						],
						updatedAt: `2026-08-03T00:00:0${turnIndex + 1}.000Z`,
					},
				},
			})
			await harness.fire("turn_end", terminalTurn())
			harness.appendEntry.mockClear()
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
			expect(harness.appendEntry).toHaveBeenCalledTimes(1)
		}

		const continued = continuations(harness)
		expect(continued).toHaveLength(2)
		expect(continued[1]?.content).toContain("Reassess the current evidence and dead ends")
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Goal paused after 3 unchanged continuation turns without substantive tool use.",
			"warning",
		)
	})

	it("pauses after three no-progress continuation turns split across a session restart", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleGoal(harness, "continue")

		expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

		// Simulate a crash-loop or a reconnecting harness re-attaching to the
		// same journal branch: only the persisted goal survives, not this
		// process's in-memory scheduling state. Before the fix, resetGoalRuntime
		// zeroed the counter here and the guard never fired.
		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleGoal(resumed, "continue")

		expect(resumed.currentGoal()?.status).toBe("paused")
		expect(resumed.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
	})

	it("pauses when every turn only appends a fresh not-yet-started todo", async () => {
		// The `<kimchi_session_goal>` prompt now explicitly invites adding a todo
		// for newly discovered work. Mere list growth must not reset the
		// no-progress guard, or an agent stuck "add a todo, plan, add a todo,
		// plan" would never trip it.
		await harness.command("keep going")
		harness.sendMessage.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName: "add_todo",
				isError: false,
				result: {
					details: {
						schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
						scope: { kind: "global" },
						todos: Array.from({ length: turnIndex }, (_, index) => ({
							id: index + 1,
							content: `Discovered item ${index + 1}`,
							status: "pending" as const,
						})),
						updatedAt: `2026-08-03T00:00:0${turnIndex}.000Z`,
					},
				},
			})
			await harness.fire("turn_end", terminalTurn())
			await settleGoal(harness, "continue")
		}

		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
	})

	it("counts starting an added todo as progress and resets the no-progress counter", async () => {
		await harness.command("keep going")
		harness.sendMessage.mockClear()

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "add_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Discovered item", status: "pending" }],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleGoal(harness, "continue")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "add_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{ id: 1, content: "Discovered item", status: "pending" },
						{ id: 2, content: "Another discovered item", status: "pending" },
					],
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleGoal(harness, "continue")

		expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

		// Starting the first item -- pending to in_progress -- is a real state
		// transition, not mere growth, so it must reset the counter.
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{ id: 1, content: "Discovered item", status: "in_progress", activeForm: "Working on it" },
						{ id: 2, content: "Another discovered item", status: "pending" },
					],
					updatedAt: "2026-08-03T00:00:03.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleGoal(harness, "continue")

		expect(harness.currentGoal()).toMatchObject({ status: "active" })
		expect(harness.currentGoal()?.unchangedContinuationTurns).toBeUndefined()
	})

	it("counts settling a todo as progress and resets the no-progress counter", async () => {
		await harness.command("keep going")
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Do the work", status: "in_progress", activeForm: "Working" }],
					updatedAt: "2026-08-03T00:00:00.000Z",
				},
			},
		})
		harness.sendMessage.mockClear()

		for (let turnIndex = 1; turnIndex <= 2; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn())
			await settleGoal(harness, "continue")
		}

		expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

		// Settling the item -- in_progress to completed -- is a real state
		// transition, so it must reset the counter even though the list didn't grow.
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Do the work", status: "completed" }],
					updatedAt: "2026-08-03T00:00:03.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleGoal(harness, "continue")

		expect(harness.currentGoal()).toMatchObject({ status: "active" })
		expect(harness.currentGoal()?.unchangedContinuationTurns).toBeUndefined()
	})

	it("does not loop when goal tools are hidden", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		harness.setActiveTools([])
		evaluateGoalMock.mockClear()
		harness.appendEntry.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(evaluateGoalMock).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.currentGoal()?.status).toBe("active")
		expect(harness.currentGoal()?.evaluationCount).toBeUndefined()
	})

	it("does not start when only part of the Todo toolset is visible", async () => {
		harness.setActiveTools([...GOAL_TOOL_NAMES, TODO_TOOL_NAMES[0]])
		await harness.command("keep going")

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("pauses accounting when an agent turn is cancelled", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		dateNow.mockReturnValue(61_000)
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn("aborted"))

		expect(harness.currentGoal()).toMatchObject({ status: "paused", timeUsedMs: 60_000 })
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_aborted", status: "paused" }),
		)
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal paused · 1m · 0 tokens")
		expect(harness.sendMessage).not.toHaveBeenCalled()
		dateNow.mockReturnValue(121_000)
		expect((await harness.tool(GET_GOAL_TOOL_NAME, {})).details.goal).toMatchObject({ timeUsedMs: 60_000 })
	})

	it("continues after failures and pauses after three consecutive failures", async () => {
		await harness.command("keep going")
		harness.sendMessage.mockClear()
		evaluateGoalMock.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			const failedTurn = terminalTurn("error")
			await harness.fire("turn_end", failedTurn)
			harness.appendEntry.mockClear()
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
			if (turnIndex < 3) expect(harness.currentGoal()?.status).toBe("active")
			expect(harness.appendEntry).not.toHaveBeenCalled()
		}

		expect(evaluateGoalMock).not.toHaveBeenCalled()
		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		for (const [message] of harness.sendMessage.mock.calls) {
			expect(message.details).toMatchObject({ source: "agent_error", revision: 1 })
		}
		expect(harness.currentGoal()?.evaluationCount).toBeUndefined()
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_errors", status: "paused" }),
		)
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal paused after 3 consecutive agent errors.", "warning")
	})

	it("pauses after three consecutive agent-error turns split across a session restart", async () => {
		await harness.command("keep going")
		evaluateGoalMock.mockClear()

		for (let turnIndex = 1; turnIndex <= 2; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn("error"))
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
		}

		expect(harness.currentGoal()).toMatchObject({ status: "active", consecutiveErrorTurns: 2 })
		expect(evaluateGoalMock).not.toHaveBeenCalled()

		// Simulate a crash-loop or a reconnecting harness re-attaching to the
		// same journal branch. Before the fix, resetGoalRuntime zeroed the
		// error streak here and a third consecutive error turn never paused.
		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })

		expect(resumed.currentGoal()?.status).toBe("paused")
		expect(resumed.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_errors", status: "paused" }),
		)
		expect(resumed.ui.notify).toHaveBeenCalledWith("Goal paused after 3 consecutive agent errors.", "warning")
	})

	it("still resets the stall-guard counters on an explicit /goal resume", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("error"))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.currentGoal()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("stop"))
		await settleGoal(harness, "continue")
		// A non-error turn already resets the error streak on its own.
		expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 1 })
		expect(harness.currentGoal()?.consecutiveErrorTurns).toBeUndefined()

		await harness.command("pause")
		await harness.command("resume")

		// A user explicitly acknowledging and continuing past a stall must
		// still zero the no-progress counter -- this is deliberate, unlike a
		// session_start replay, which must not touch it.
		expect(harness.currentGoal()).toMatchObject({ status: "active" })
		expect(harness.currentGoal()?.consecutiveErrorTurns).toBeUndefined()
		expect(harness.currentGoal()?.unchangedContinuationTurns).toBeUndefined()

		// Confirm it was a real reset and not merely hidden: two more
		// no-progress turns land at 2, not 3 (which would already be paused).
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: Date.now() })
		await settleGoal(harness, "continue")
		expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })
	})

	it("persists a genuine progress reset across a session restart, not just increments", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("error"))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.currentGoal()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("stop"))
		await settleGoal(harness, "continue")
		expect(harness.currentGoal()?.consecutiveErrorTurns).toBeUndefined()

		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		// If the reset above hadn't really been journaled, a stale streak of 1
		// plus these two errors would already reach the pause threshold. It
		// must take all three post-restart errors, proving the reset was real.
		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentGoal()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentGoal()).toMatchObject({ status: "active", consecutiveErrorTurns: 2 })

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 5, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentGoal()?.status).toBe("paused")
	})

	it("stops continuation when the token budget is reached", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		const budgetTurn = terminalTurn("stop", { input: 80, output: 20 })
		await harness.fire("agent_end", { type: "agent_end", messages: [budgetTurn.message] })
		await harness.fire("turn_end", budgetTurn)
		harness.appendEntry.mockClear()
		evaluateGoalMock.mockClear()
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentGoal()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal budget reached · <1m · 100/100 tokens")
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal stopped after reaching its 100 token budget.", "warning")
		expect(evaluateGoalMock).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("refuses to resume a goal that is paused but still over its token budget", async () => {
		// An aborted turn can both push tokensUsed past the budget and force a
		// pause in the same turn_end (budget_limited is overwritten by paused),
		// leaving a goal that is paused yet already over budget.
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("aborted", { input: 80, output: 20 }))
		expect(harness.currentGoal()).toMatchObject({ status: "paused", tokenBudget: 100, tokensUsed: 100 })

		harness.sendMessage.mockClear()
		harness.ui.notify.mockClear()

		await harness.command("resume")

		expect(harness.currentGoal()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Goal token budget is exhausted. Start a replacement goal with a new budget.",
			"warning",
		)
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Goal resumed.", "info")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("settles a headless resume instead of hanging when the goal is paused but over budget", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("aborted", { input: 80, output: 20 }))
		expect(harness.currentGoal()).toMatchObject({ status: "paused", tokenBudget: 100, tokensUsed: 100 })

		const capturedBranch = [...harness.branch]
		const headless = createHarness({ hasUI: false })
		headless.setSession("session-a", capturedBranch)
		await headless.fire("session_start", { type: "session_start", reason: "resume" })
		expect(headless.sendMessage).not.toHaveBeenCalled()

		let resolved = false
		const command = headless.command("resume").then(() => {
			resolved = true
		})
		const TIMED_OUT = Symbol("timed out")
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
			timer = setTimeout(() => resolve(TIMED_OUT), 250)
		})
		const winner = await Promise.race([command, timeout])
		if (timer) clearTimeout(timer)

		// If this regresses, the resume command hangs forever (an unresolvable
		// waiter is created after the goal is already terminal) and the race
		// above times out instead of the command winning.
		expect(winner).not.toBe(TIMED_OUT)
		expect(resolved).toBe(true)
		expect(headless.currentGoal()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(headless.sendMessage).not.toHaveBeenCalled()
	})

	it("serializes edit and agent-end so no old-revision continuation is scheduled", async () => {
		await harness.command("revision one")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await Promise.all([
			harness.command("edit revision two"),
			harness.fire("agent_end", { type: "agent_end", messages: [] }),
		])

		expect(harness.currentGoal()?.revision).toBe(2)
		for (const [message] of harness.sendMessage.mock.calls) {
			expect(message.details).toMatchObject({ revision: 2 })
		}
	})

	it("replays rewind and fork branches independently", async () => {
		await harness.command("revision one")
		const revision1Entry = harness.branch.at(-1)
		await harness.command("edit revision two")
		expect(harness.currentGoal()?.revision).toBe(2)

		harness.setBranch(revision1Entry ? [revision1Entry] : [])
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "b", newLeafId: "a" })
		expect(harness.currentGoal()).toMatchObject({ objective: "revision one", revision: 1 })

		harness.setSession("fork-session", revision1Entry ? [revision1Entry] : [])
		await harness.fire("session_start", { type: "session_start", reason: "fork" })
		await harness.command("edit fork objective")
		expect(harness.currentGoal()).toMatchObject({ objective: "fork objective", revision: 2 })
	})

	it("accepts settled todos restored after the current goal revision", async () => {
		await harness.command("restore the session")
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Restore the session", status: "completed" }],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
		])

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()
	})

	it("requires restored todos to be reconciled after editing the same goal", async () => {
		await harness.command("revision one")
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish revision one", status: "completed" }],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
		])
		await harness.command("edit revision two")

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("settle every item") })
	})

	it("restores the latest goal and settled todos across repeated compactions", async () => {
		await harness.command("revision one")
		harness.setBranch([...harness.branch, compactionEntry("first summary")])
		await harness.command("edit revision two")
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [
					{
						id: 1,
						content: "Finish revision two",
						status: "in_progress",
						activeForm: "Verifying revision two",
						note: "Implementation is complete; focused verification remains",
					},
				],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
			compactionEntry("second summary"),
		])

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })
		const context = (await harness.fire("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "second summary" }], timestamp: Date.now() }],
		})) as { messages: ContextEvent["messages"] }
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		expect(harness.currentGoal()).toMatchObject({ objective: "revision two", revision: 2 })
		expect(JSON.stringify(context.messages)).toContain("revision two")
		expect(JSON.stringify(context.messages)).not.toContain("Verifying revision two")
		expect(JSON.stringify(context.messages)).not.toContain("focused verification remains")

		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [
					{
						id: 1,
						content: "Finish revision two",
						status: "completed",
						note: "Focused verification passed",
					},
				],
				updatedAt: "2026-08-03T00:00:02.000Z",
			}),
			compactionEntry("third summary"),
		])
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "after", newLeafId: "final" })
		const settledContext = (await harness.fire("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "third summary" }], timestamp: Date.now() }],
		})) as { messages: ContextEvent["messages"] }
		expect(JSON.stringify(settledContext.messages)).toContain("Focused verification passed")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()
	})

	it("retains bounded lessons after terminal todos leave the post-compaction snapshot", async () => {
		await harness.command("preserve durable findings")
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [
					{
						id: 1,
						content: "Choose the persistence path",
						status: "completed",
						note: "Decision: reuse the native session journal",
					},
				],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [],
				updatedAt: "2026-08-03T00:00:02.000Z",
			}),
			compactionEntry("durable handoff"),
		])

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })
		const context = (await harness.fire("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }],
		})) as { messages: ContextEvent["messages"] }
		const goalContext = context.messages.find(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_MESSAGE_TYPE,
		)
		const goalContextText = JSON.stringify(goalContext)

		expect(goalContextText).toContain("lessons")
		expect(goalContextText).toContain("decision")
		expect(goalContextText).toContain("reuse the native session journal")
		expect(goalContextText).not.toContain("Choose the persistence path")

		await harness.command("edit a replacement objective")
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "after", newLeafId: "edited" })
		const editedContext = (await harness.fire("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }],
		})) as { messages: ContextEvent["messages"] }

		expect(JSON.stringify(editedContext.messages)).toContain("reuse the native session journal")
	})

	it("keeps goals and todo completion isolated while switching sessions", async () => {
		await harness.command("session A goal")
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish session A", status: "completed" }],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
		])
		const sessionABranch = [...harness.branch]

		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })
		await harness.command("session B goal")
		const sessionBBranch = [...harness.branch]

		harness.setSession("session-a", sessionABranch)
		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(harness.currentGoal()?.objective).toBe("session A goal")
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()

		harness.setSession("session-b", sessionBBranch)
		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(harness.currentGoal()?.objective).toBe("session B goal")
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("visible tactical todo") })
	})

	describe("configurable policy settings", () => {
		it("pauses at the configured maxUnchangedContinuations count, not the default", async () => {
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, maxUnchangedContinuations: 2 })
			await harness.command("keep going")
			harness.sendMessage.mockClear()

			await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
			await settleGoal(harness, "continue")
			expect(harness.currentGoal()).toMatchObject({ status: "active", unchangedContinuationTurns: 1 })

			await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
			await settleGoal(harness, "continue")

			expect(harness.currentGoal()?.status).toBe("paused")
			expect(harness.events.emit).toHaveBeenLastCalledWith(
				GOAL_EVENTS.STALLED,
				expect.objectContaining({ reason: "no_progress", continuationCount: 2, status: "paused" }),
			)
			expect(harness.ui.notify).toHaveBeenCalledWith(
				"Goal paused after 2 unchanged continuation turns without substantive tool use.",
				"warning",
			)
		})

		it("pauses at the configured maxConsecutiveErrors count, not the default", async () => {
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, maxConsecutiveErrors: 2 })
			await harness.command("keep going")
			harness.sendMessage.mockClear()
			evaluateGoalMock.mockClear()

			for (let turnIndex = 1; turnIndex <= 2; turnIndex++) {
				await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
				await harness.fire("turn_end", terminalTurn("error"))
				harness.appendEntry.mockClear()
				await harness.fire("agent_end", { type: "agent_end", messages: [] })
				await harness.fire("agent_settled", { type: "agent_settled" })
				if (turnIndex < 2) expect(harness.currentGoal()?.status).toBe("active")
			}

			expect(evaluateGoalMock).not.toHaveBeenCalled()
			expect(harness.currentGoal()?.status).toBe("paused")
			expect(harness.events.emit).toHaveBeenLastCalledWith(
				GOAL_EVENTS.PAUSED,
				expect.objectContaining({ reason: "agent_errors", status: "paused" }),
			)
			expect(harness.ui.notify).toHaveBeenCalledWith("Goal paused after 2 consecutive agent errors.", "warning")
		})

		it("does not schedule a resume continuation on session_start when autoResume is disabled", async () => {
			await harness.command("ship it")
			const capturedBranch = [...harness.branch]

			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, autoResume: false })
			const resumed = createHarness()
			resumed.setSession("session-a", capturedBranch)
			await resumed.fire("session_start", { type: "session_start", reason: "resume" })

			expect(resumed.currentGoal()?.status).toBe("active")
			expect(resumed.sendMessage).not.toHaveBeenCalled()
		})

		it("still schedules a resume continuation when autoResume is true (default)", async () => {
			await harness.command("ship it")
			const capturedBranch = [...harness.branch]

			// Default mock already resolves to DEFAULT_GOAL_SETTINGS (autoResume: true);
			// set it explicitly here so the intent of this test reads standalone.
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, autoResume: true })
			const resumed = createHarness()
			resumed.setSession("session-a", capturedBranch)
			await resumed.fire("session_start", { type: "session_start", reason: "resume" })

			expect(resumed.currentGoal()?.status).toBe("active")
			expect(resumed.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: GOAL_CONTROL_MESSAGE_TYPE }),
				expect.objectContaining({ triggerTurn: true }),
			)
		})

		it("applies defaultTokenBudget to /goal <objective> without --tokens", async () => {
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("ship it")

			expect(harness.currentGoal()).toMatchObject({ tokenBudget: 500 })
		})

		it("lets an explicit --tokens win over a configured defaultTokenBudget", async () => {
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("--tokens 250 ship it")

			expect(harness.currentGoal()).toMatchObject({ tokenBudget: 250 })
		})

		it("still lets an explicit --tokens win when replacing a goal under a configured default", async () => {
			goalSettingsMock.mockReturnValue({ ...DEFAULT_GOAL_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("first")
			expect(harness.currentGoal()).toMatchObject({ tokenBudget: 500 })

			await harness.command("--tokens 250 second")
			expect(harness.currentGoal()).toMatchObject({ objective: "second", tokenBudget: 250 })
		})
	})
})

function createHarness(options: { hasUI?: boolean } = {}) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const commands = new Map<string, CommandConfig>()
	const tools = new Map<string, ToolConfig>()
	let sessionId = "session-a"
	let branch: SessionEntry[] = []
	let idle = true
	let pending = false
	let activeTools: string[] = [...GOAL_TOOL_NAMES, ...TODO_TOOL_NAMES]

	let idleError: Error | undefined
	const ui = {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		editor: vi.fn(async (_title: string, value: string) => value),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	}
	const appendEntry = vi.fn((customType: string, data: GoalJournalEntry) => {
		branch.push(customEntry(customType, data))
	})
	const sendMessage = vi.fn()
	const waitForIdle = vi.fn(async (): Promise<void> => undefined)
	const events = { emit: vi.fn() }
	const pi = {
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
		registerCommand: vi.fn((name: string, config: CommandConfig) => commands.set(name, config)),
		registerTool: vi.fn((tool: ToolConfig) => tools.set(tool.name, tool)),
		registerMessageRenderer: vi.fn(),
		appendEntry,
		sendMessage,
		events,
		getActiveTools: vi.fn(() => activeTools),
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		ui,
		waitForIdle,
		isIdle: () => {
			if (idleError) {
				const error = idleError
				idleError = undefined
				throw error
			}
			return idle
		},
		hasPendingMessages: () => pending,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntries: () => branch,
		},
	} as unknown as ExtensionCommandContext

	goalExtension(pi)

	return {
		commands,
		tools,
		ui,
		appendEntry,
		sendMessage,
		events,
		waitForIdle,
		get branch() {
			return branch
		},
		setBranch(entries: SessionEntry[]) {
			branch = [...entries]
		},
		setSession(nextSessionId: string, entries: SessionEntry[]) {
			sessionId = nextSessionId
			branch = [...entries]
		},
		setIdle(value: boolean) {
			idle = value
		},
		setIdleError(error: Error) {
			idleError = error
		},
		setPending(value: boolean) {
			pending = value
		},
		setActiveTools(value: string[]) {
			activeTools = value
		},
		async fire(event: string, payload: unknown): Promise<unknown> {
			let result: unknown
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload as never, ctx)
			}
			// session_start defers its resume kick past dispatch with a real
			// setTimeout(0) (see index.ts) so an embedder's own incoming prompt
			// can win the race for the streaming slot instead of crashing against
			// it. Flush that one macrotask here so callers observe the settled
			// outcome instead of a callback still pending on the real timer queue.
			if (event === "session_start") {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			return result
		},
		async command(args: string): Promise<void> {
			const goal = commands.get("goal")
			if (!goal) throw new Error("goal command not registered")
			await goal.handler(args, ctx)
		},
		async tool(name: string, params: Record<string, unknown>) {
			const tool = tools.get(name)
			if (!tool) throw new Error(`${name} tool not registered`)
			return tool.execute("call-1", params, new AbortController().signal, () => undefined, ctx)
		},
		currentGoal(): SessionGoal | undefined {
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index]
				if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_ENTRY_TYPE) continue
				const journal = entry.data as GoalJournalEntry
				if (journal.op === "clear") return undefined
				return journal.goal
			}
			return undefined
		},
		latestJournal(): GoalJournalEntry | undefined {
			const entry = branch.findLast(
				(candidate) => candidate.type === "custom" && candidate.customType === GOAL_CUSTOM_ENTRY_TYPE,
			)
			return entry?.type === "custom" ? (entry.data as GoalJournalEntry) : undefined
		},
	}
}

/** Hidden control messages that drive the next goal turn. */
function continuations(harness: ReturnType<typeof createHarness>): Array<{ content: string }> {
	return harness.sendMessage.mock.calls
		.map((call) => call[0])
		.filter((message) => message?.customType === GOAL_CONTROL_MESSAGE_TYPE)
}

async function settleGoal(
	harness: ReturnType<typeof createHarness>,
	verdict: "continue" | "met" | "impossible" | "unavailable" = "continue",
): Promise<void> {
	evaluateGoalMock.mockResolvedValueOnce(
		verdict === "unavailable"
			? { verdict, reason: "No evaluator model is available." }
			: {
					verdict,
					reason: verdict === "met" ? "All requirements are evidenced." : "More work is required.",
					model: "test/evaluator",
					usage: EVALUATOR_USAGE,
				},
	)
	await harness.fire("agent_end", { type: "agent_end", messages: [] })
	await harness.fire("agent_settled", { type: "agent_settled" })
}

/**
 * Starts an evaluation and leaves it pending, without awaiting `agent_settled`: the handler
 * blocks on the evaluator while it runs, so the caller drives whatever it's testing in that
 * window, then releases a result and awaits `settled`.
 */
async function holdEvaluation(harness: ReturnType<typeof createHarness>): Promise<{
	release: (value: Awaited<ReturnType<typeof evaluateGoal>>) => void
	settled: Promise<unknown>
	signal: AbortSignal | undefined
}> {
	let release: (value: Awaited<ReturnType<typeof evaluateGoal>>) => void = () => undefined
	evaluateGoalMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve
			}),
	)
	await harness.fire("agent_end", { type: "agent_end", messages: [] })
	const settled = harness.fire("agent_settled", { type: "agent_settled" })
	await vi.waitFor(() => expect(evaluateGoalMock).toHaveBeenCalled())
	const signal = evaluateGoalMock.mock.calls.at(-1)?.[0].signal

	return { release, settled, signal }
}

async function completeVisibleTodo(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.fire("tool_execution_end", {
		type: "tool_execution_end",
		toolName: "mark_todo",
		isError: false,
		result: {
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the goal", status: "completed" }],
				updatedAt: "2026-08-03T00:00:02.000Z",
			},
		},
	})
}

function terminalTurn(
	stopReason: "stop" | "error" | "aborted" = "stop",
	usage: { input?: number; output?: number } = { input: 0, output: 0 },
) {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done for now" }],
			stopReason,
			usage,
			timestamp: Date.now(),
		},
		toolResults: [],
	}
}

function customEntry(customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	} as SessionEntry
}

function compactionEntry(summary: string): SessionEntry {
	return {
		type: "compaction",
		id: randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: randomUUID(),
		tokensBefore: 100_000,
	}
}

function requireGoal(goal: SessionGoal | undefined): SessionGoal {
	if (!goal) throw new Error("expected current goal")
	return goal
}
