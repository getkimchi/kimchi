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
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
import { GOAL_EVENTS } from "./domain-events.js"
import goalExtension from "./index.js"
import type { GoalJournalEntry, SessionGoal } from "./types.js"

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
		let releaseIdle: () => void = () => undefined
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve
		})
		headlessHarness.waitForIdle.mockReturnValueOnce(idle)

		let resolved = false
		const command = headlessHarness.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headlessHarness.waitForIdle).toHaveBeenCalledOnce())
		expect(resolved).toBe(false)

		releaseIdle()
		await command
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
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
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
		const goal = requireGoal(harness.currentGoal())
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: goal.id,
			revision: goal.revision,
			status: "complete",
			completion_confidence: "proven",
		})
		await harness.fire("turn_end", terminalTurn("stop", { input: 200, output: 50 }))

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
					scope: { kind: "global" },
					todos: [{ content: "Implement the goal", status: "in_progress" }],
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
					scope: { kind: "global" },
					todos: [{ content: "Implement the goal", status: "completed" }],
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
			result: { details: { scope: { kind: "global" }, todos: [] } },
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

	it("pauses, resumes, clears, and restores the clear tombstone", async () => {
		await harness.command("ship it")
		harness.setIdle(false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.command("pause")
		expect(harness.currentGoal()?.status).toBe("paused")
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

		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		expect(harness.currentGoal()).toBeUndefined()
		expect((await harness.tool(GET_GOAL_TOOL_NAME, {})).details.goal).toBeNull()
	})

	it("uses the active turn revision internally for model updates", async () => {
		await harness.command("finish without copying protocol metadata")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })

		const result = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})

		expect(result.content[0].text).toContain("marked complete")
		expect(result.terminate).toBe(true)
		expect(harness.currentGoal()?.status).toBe("complete")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			GOAL_EVENTS.COMPLETED,
			expect.objectContaining({ completionConfidence: "tested", status: "complete" }),
		)
	})

	it("keeps completion active until confidence is tested", async () => {
		await harness.command("prove it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })

		const missing = await harness.tool(UPDATE_GOAL_TOOL_NAME, { status: "complete" })
		expect(missing.content[0].text).toContain("completion_confidence must be tested or proven")
		expect(harness.currentGoal()?.status).toBe("active")

		const partial = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "partial",
		})
		expect(partial.content[0].text).toContain("completion_confidence must be tested or proven")
		expect(harness.currentGoal()?.status).toBe("active")

		const tested = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		expect(tested.terminate).toBe(true)
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
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
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
		expect(JSON.stringify(goalMessages[0])).toContain("Do not call get_goal while this context is present")
		expect(JSON.stringify(goalMessages[0])).toContain("Call update_goal only after receiving the final todo result")
		expect(JSON.stringify(goalMessages[0])).toContain("as the only tool call in that response")
		expect(result.messages).toContain(other)
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

	it("continues from the drained agent boundary and defers to pending input", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn())
		expect(harness.sendMessage).not.toHaveBeenCalled()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "agent_end", revision: 1 }),
		})
		expect(harness.sendMessage.mock.lastCall?.[1]).toMatchObject({ deliverAs: "followUp" })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		harness.setPending(true)
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not loop when goal tools are hidden", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		harness.setActiveTools([])
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		expect(harness.sendMessage).not.toHaveBeenCalled()

		expect(harness.sendMessage).not.toHaveBeenCalled()
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
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal paused · 1m · 0 tokens")
		expect(harness.sendMessage).not.toHaveBeenCalled()
		dateNow.mockReturnValue(121_000)
		expect((await harness.tool(GET_GOAL_TOOL_NAME, {})).details.goal).toMatchObject({ timeUsedMs: 60_000 })
	})

	it("continues after failures and pauses after three consecutive failures", async () => {
		await harness.command("keep going")
		harness.sendMessage.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn("error"))
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			if (turnIndex < 3) expect(harness.currentGoal()?.status).toBe("active")
		}

		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		for (const [message] of harness.sendMessage.mock.calls) {
			expect(message.details).toMatchObject({ source: "agent_end", revision: 1 })
		}
		expect(harness.currentGoal()?.status).toBe("paused")
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal paused after 3 consecutive agent errors.", "warning")
	})

	it("stops continuation when the token budget is reached", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn("stop", { input: 80, output: 20 }))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })

		expect(harness.currentGoal()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal budget reached · <1m · 100/100 tokens")
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal stopped after reaching its 100 token budget.", "warning")
		expect(harness.sendMessage).not.toHaveBeenCalled()
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

	it("does not carry restored todos across goal revisions", async () => {
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
		).toMatchObject({ block: true, reason: expect.stringContaining("visible tactical todo") })
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
				todos: [{ id: 1, content: "Finish revision two", status: "completed" }],
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
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_GOAL_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()
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
		isIdle: () => idle,
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
