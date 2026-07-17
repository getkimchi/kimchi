import { randomUUID } from "node:crypto"
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import {
	GET_GOAL_TOOL_NAME,
	GOAL_CONTEXT_MESSAGE_TYPE,
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
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
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
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
		expect(harness.appendEntry).toHaveBeenCalledWith(
			GOAL_CUSTOM_ENTRY_TYPE,
			expect.objectContaining({ op: "put", goal: expect.objectContaining({ id: first?.id }) }),
		)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ display: false, details: expect.objectContaining({ revision: 1 }) }),
			{ triggerTurn: true, deliverAs: "steer" },
		)

		harness.ui.confirm.mockResolvedValueOnce(false)
		await harness.command("ship feature B")
		expect(harness.currentGoal()?.id).toBe(first?.id)

		harness.ui.confirm.mockResolvedValueOnce(true)
		await harness.command("ship feature B")
		const replacement = harness.currentGoal()
		expect(replacement).toMatchObject({ revision: 1, objective: "ship feature B", status: "active" })
		expect(replacement?.id).not.toBe(first?.id)
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
		const first = requireGoal(harness.currentGoal())
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: first.id,
			revision: first.revision,
			status: "complete",
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
		})
		await harness.fire("turn_end", terminalTurn("stop", { input: 200, output: 50 }))

		expect(harness.currentGoal()).toMatchObject({ status: "complete", tokensUsed: 1_750, timeUsedMs: 3_500 })
		expect(harness.ui.notify).toHaveBeenCalledWith("Goal complete in 3.5s · 1.8k tokens.", "info")
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", undefined)
	})

	it("treats missing usage fields as zero", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.fire("turn_end", terminalTurn("stop", { input: 25 }))

		expect(harness.currentGoal()?.tokensUsed).toBe(25)
	})

	it("requires a visible todo list before other tools for every goal revision", async () => {
		await harness.command("ship it")

		const blocked = await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("create_todos") })
		expect(
			await harness.fire("tool_call", { type: "tool_call", toolName: GET_GOAL_TOOL_NAME, input: {} }),
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
		).toMatchObject({ block: true })

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
		).toMatchObject({ block: true, reason: expect.stringContaining("Reconcile") })

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
		).toMatchObject({ block: true, reason: expect.stringContaining("clear") })
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
		).toBeUndefined()

		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })
		await harness.command("another session goal")
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
		})

		await harness.command("edit changed objective")
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
		})
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

		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
		})
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
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
		})
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

	it("rejects stale and invalid model updates while accepting both terminal statuses", async () => {
		await harness.command("original")
		const revision1 = requireGoal(harness.currentGoal())
		await harness.command("edit changed")
		const revision2 = requireGoal(harness.currentGoal())

		const stale = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: revision1.id,
			revision: revision1.revision,
			status: "complete",
		})
		expect(stale.content[0].text).toContain(`current goal is ${revision2.id} revision 2`)
		expect(harness.currentGoal()?.status).toBe("active")

		const invalid = await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: revision2.id,
			revision: revision2.revision,
			status: "paused",
		})
		expect(invalid.content[0].text).toContain("invalid terminal status")

		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: revision2.id,
			revision: revision2.revision,
			status: "blocked",
			reason: "needs user input",
		})
		expect(harness.currentGoal()?.status).toBe("blocked")

		await harness.command("resume")
		const resumed = requireGoal(harness.currentGoal())
		await harness.tool(UPDATE_GOAL_TOOL_NAME, {
			goalId: resumed.id,
			revision: resumed.revision,
			status: "complete",
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

	it.each(["error", "aborted"] as const)("pauses accounting when an agent turn ends with %s", async (stopReason) => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		dateNow.mockReturnValue(61_000)
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn(stopReason))

		expect(harness.currentGoal()).toMatchObject({ status: "paused", timeUsedMs: 60_000 })
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith("goal", "Goal paused · 1m · 0 tokens")
		expect(harness.sendMessage).not.toHaveBeenCalled()
		dateNow.mockReturnValue(121_000)
		expect((await harness.tool(GET_GOAL_TOOL_NAME, {})).details.goal).toMatchObject({ timeUsedMs: 60_000 })
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
})

function createHarness() {
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
		getActiveTools: vi.fn(() => activeTools),
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui,
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

function requireGoal(goal: SessionGoal | undefined): SessionGoal {
	if (!goal) throw new Error("expected current goal")
	return goal
}
