import { randomUUID } from "node:crypto"
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { markHarnessSteer } from "../steer-marker.js"
import { registerTodosCommand } from "../todos/command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "../todos/constants.js"
import { __resetTodoStore, applyWriteTodos, GLOBAL_TODO_SCOPE, getTodosForScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoItem } from "../todos/types.js"
import {
	FERMENT_V2_CONTEXT_MESSAGE_TYPE,
	FERMENT_V2_CONTROL_MESSAGE_TYPE,
	FERMENT_V2_CUSTOM_ENTRY_TYPE,
	FERMENT_V2_TOOL_NAMES,
	GET_FERMENT_V2_TOOL_NAME,
	UPDATE_FERMENT_V2_TOOL_NAME,
} from "./constants.js"
import { FERMENT_V2_EVENTS } from "./domain-events.js"
import { evaluateFermentV2 } from "./evaluator.js"
import fermentV2Extension from "./index.js"
import { DEFAULT_FERMENT_V2_SETTINGS, getFermentV2Settings } from "./settings.js"
import type { FermentV2JournalEntry, SessionFermentV2 } from "./types.js"

vi.mock("./evaluator.js", () => ({ evaluateFermentV2: vi.fn() }))
vi.mock("./settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./settings.js")>()
	return { ...actual, getFermentV2Settings: vi.fn() }
})

const evaluateFermentV2Mock = vi.mocked(evaluateFermentV2)
const fermentV2SettingsMock = vi.mocked(getFermentV2Settings)
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
	description?: string
	promptSnippet?: string
	promptGuidelines?: string[]
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

describe("Ferment V2 extension", () => {
	let harness: ReturnType<typeof createHarness>

	beforeEach(async () => {
		__resetTodoStore()
		evaluateFermentV2Mock.mockResolvedValue({
			verdict: "continue",
			reason: "More work is required.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
		harness = createHarness()
		await harness.fire("session_start", { type: "session_start", reason: "new" })
	})

	afterEach(async () => {
		await harness.fire("session_shutdown", { type: "session_shutdown" })
		__resetTodoStore()
		vi.restoreAllMocks()
	})

	it("registers the commands, completions, tools, and empty-state behavior", async () => {
		expect([...harness.commands.keys()]).toEqual(["ferment-v2"])
		expect([...harness.tools.keys()]).toEqual([...FERMENT_V2_TOOL_NAMES])
		expect(harness.tools.get(UPDATE_FERMENT_V2_TOOL_NAME)?.promptGuidelines).toContain(
			"Claim complete only after current evidence proves every requirement is met. Report blocked only when the objective cannot be completed without user or external action after trying viable alternatives; one unavailable preferred tool or check is not a blockage.",
		)
		const updateTool = harness.tools.get(UPDATE_FERMENT_V2_TOOL_NAME)
		expect(
			[updateTool?.description, updateTool?.promptSnippet, ...(updateTool?.promptGuidelines ?? [])].join("\n"),
		).not.toMatch(/\bevaluator\b|independent completion|separate check|after the final todo mutation|only tool call/i)
		expect(
			harness.commands
				.get("ferment-v2")
				?.getArgumentCompletions?.("re")
				?.map((entry) => entry.value),
		).toEqual(["resume"])
		expect(harness.commands.get("ferment-v2")?.getArgumentCompletions?.("ed")?.[0]).toMatchObject({
			value: "edit ",
			label: "edit",
		})

		await harness.command("")
		expect(harness.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("No Ferment V2 is currently set"),
			"info",
		)

		const result = await harness.tool(GET_FERMENT_V2_TOOL_NAME, {})
		expect(result.details.fermentV2).toBeNull()
	})

	it("creates a Ferment V2, persists it, and confirms unfinished replacement", async () => {
		await harness.command("ship feature A")
		const first = harness.currentFermentV2()

		expect(first).toMatchObject({ revision: 1, objective: "ship feature A", status: "active" })
		expect(harness.events.emit).toHaveBeenCalledWith(
			FERMENT_V2_EVENTS.STARTED,
			expect.objectContaining({ fermentV2Id: first?.id, revision: 1, status: "active" }),
		)
		expect(harness.events.emit.mock.lastCall?.[1]).not.toHaveProperty("objective")
		expect(harness.appendEntry).toHaveBeenCalledWith(
			FERMENT_V2_CUSTOM_ENTRY_TYPE,
			expect.objectContaining({ op: "put", fermentV2: expect.objectContaining({ id: first?.id }) }),
		)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ display: false, details: expect.objectContaining({ revision: 1 }) }),
			{ triggerTurn: true, deliverAs: "steer" },
		)
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("leave the settled list visible")
		expect(harness.sendMessage.mock.lastCall?.[0].content).not.toContain("Before other tools")

		harness.ui.confirm.mockResolvedValueOnce(false)
		await harness.command("ship feature B")
		expect(harness.currentFermentV2()?.id).toBe(first?.id)

		harness.ui.confirm.mockResolvedValueOnce(true)
		await harness.command("ship feature B")
		const replacement = harness.currentFermentV2()
		expect(replacement).toMatchObject({ revision: 1, objective: "ship feature B", status: "active" })
		expect(replacement?.id).not.toBe(first?.id)
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.REPLACED,
			expect.objectContaining({ fermentV2Id: replacement?.id, revision: 1, status: "active" }),
		)
	})

	it("waits for a headless Ferment V2 turn before resolving the command", async () => {
		const headlessHarness = createHarness({ hasUI: false })

		let resolved = false
		const command = headlessHarness.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headlessHarness.sendMessage).toHaveBeenCalledOnce())
		expect(resolved).toBe(false)
		expect(headlessHarness.waitForIdle).not.toHaveBeenCalled()

		await settleFermentV2(headlessHarness, "unavailable")
		await command
		expect(resolved).toBe(true)
	})

	it("keeps a blocked headless command pending until the accounted turn settles", async () => {
		const headlessHarness = createHarness({ hasUI: false })
		let resolved = false
		const command = headlessHarness.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headlessHarness.sendMessage).toHaveBeenCalledOnce())

		await headlessHarness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const result = await headlessHarness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "blocked",
			reason: "needs user input",
		})
		expect(result.terminate).toBe(true)
		expect(headlessHarness.currentFermentV2()).toMatchObject({ status: "blocked", tokensUsed: 0 })
		expect(resolved).toBe(false)

		await headlessHarness.fire("turn_end", terminalTurn("stop", { input: 7, output: 3 }))
		expect(resolved).toBe(false)
		expect(headlessHarness.currentFermentV2()).toMatchObject({ status: "blocked", tokensUsed: 10 })
		expect(headlessHarness.branch.at(-1)?.type).toBe("custom")
		expect((headlessHarness.branch.at(-1) as { data: FermentV2JournalEntry }).data).toMatchObject({
			op: "put",
			fermentV2: { status: "blocked", tokensUsed: 10 },
		})

		await headlessHarness.fire("agent_end", { type: "agent_end", messages: [] })
		await headlessHarness.fire("agent_settled", { type: "agent_settled" })
		await command
		expect(resolved).toBe(true)
	})

	it("rejects Ferment V2 creation when required Ferment V2 or Todo tools are unavailable", async () => {
		const headlessHarness = createHarness({ hasUI: false })
		headlessHarness.setActiveTools([])

		await headlessHarness.command("ship feature A")
		expect(headlessHarness.sendMessage).not.toHaveBeenCalled()
		expect(headlessHarness.currentFermentV2()).toBeUndefined()
		expect(headlessHarness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 requires the Ferment V2 and Todo tools to be enabled before it can run.",
			"warning",
		)
	})

	it("rejects Ferment V2 replacement before asking when required tools are unavailable", async () => {
		await harness.command("ship feature A")
		const first = harness.currentFermentV2()
		harness.ui.confirm.mockClear()
		harness.setActiveTools([])

		await harness.command("ship feature B")

		expect(harness.ui.confirm).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()?.id).toBe(first?.id)
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 requires the Ferment V2 and Todo tools to be enabled before it can run.",
			"warning",
		)
	})

	it("resolves a headless waiter when the Ferment V2 tools go away mid-evaluation", async () => {
		const headless = createHarness({ hasUI: false })

		let resolved = false
		const command = headless.command("ship feature A").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())
		expect(resolved).toBe(false)

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

		expect(winner).not.toBe(TIMED_OUT)
		expect(resolved).toBe(true)
	})

	it("does not create a separate working widget while evaluation is pending", async () => {
		await harness.command("ship feature A")
		harness.ui.setWidget.mockClear()

		const { release, settled } = await holdEvaluation(harness)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(harness.ui.setWidget).not.toHaveBeenCalled()

		release({ verdict: "continue", reason: "More work is required.", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await settled
	})

	it("hides completion prose without removing the thinking block", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "meta completion reasoning", thinkingSignature: "opaque" },
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "unverified completion candidate" },
			],
			stopReason: "toolUse",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}

		await harness.fire("message_start", { type: "message_start", message })
		await completeVisibleTodo(harness)
		const update = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " leaked candidate" },
		}
		await harness.fire("message_update", update)
		const ended = await harness.fire("message_end", { type: "message_end", message })

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "meta completion reasoning", thinkingSignature: "opaque" },
			{ type: "thinking", thinking: "unsigned reasoning" },
			{ type: "text", text: "" },
		])
		expect(update.assistantMessageEvent.delta).toBe(" leaked candidate")
		expect(ended).toEqual({
			message: expect.objectContaining({
				content: [
					{ type: "thinking", thinking: "meta completion reasoning", thinkingSignature: "opaque" },
					{ type: "thinking", thinking: "unsigned reasoning" },
				],
			}),
		})
		const providerContext = JSON.stringify(
			await harness.fire("context", {
				type: "context",
				messages: [(ended as { message: unknown }).message],
			}),
		)
		expect(providerContext).toContain('"thinkingSignature":"opaque"')
		expect(providerContext).toContain("meta completion reasoning")
		expect(providerContext).not.toContain('"thinking":"","redacted":true')
	})

	it("withholds trailing text after the current run reaches its token budget", async () => {
		await harness.command("--tokens 100 ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const claim = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "claim-before-budget",
					name: UPDATE_FERMENT_V2_TOOL_NAME,
					arguments: { status: "complete", completion_confidence: "proven" },
				},
			],
			stopReason: "toolUse",
			usage: { input: 80, output: 20 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: claim })
		await harness.fire("message_end", { type: "message_end", message: claim })
		await harness.fire("turn_end", terminalTurn("stop", { input: 80, output: 20 }))
		expect(harness.currentFermentV2()?.status).toBe("budget_limited")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		const trailing = {
			role: "assistant",
			content: [{ type: "text", text: "unverified post-budget output" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: trailing })
		const ended = await harness.fire("message_end", { type: "message_end", message: trailing })

		expect(trailing.content).toEqual([{ type: "text", text: "" }])
		expect(ended).toEqual({ message: expect.objectContaining({ content: [] }) })
	})

	it("continues without evaluation when the active turn emits only thinking", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "I think this is done" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}

		await harness.fire("message_start", { type: "message_start", message })
		const ended = await harness.fire("message_end", { type: "message_end", message })
		harness.setBranch([...harness.branch, messageEntry((ended as { message: typeof message }).message, null)])
		await harness.fire("agent_end", { type: "agent_end", messages: [message] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "missing_final_answer_text" }),
		})
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("visible answer text")
	})

	it("keeps progress visible when settled Todos precede an ordinary tool call", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "Reopening tactical work." },
				{
					type: "toolCall",
					id: "add-follow-up",
					name: "add_todo",
					arguments: { content: "Verify the remaining concern", status: "in_progress" },
				},
			],
			stopReason: "toolUse",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}

		await harness.fire("message_start", { type: "message_start", message })
		const ended = await harness.fire("message_end", { type: "message_end", message })
		await harness.fire("agent_end", { type: "agent_end", messages: [] })

		expect(ended).toEqual({
			message: expect.objectContaining({
				content: expect.arrayContaining([{ type: "text", text: "Reopening tactical work." }]),
			}),
		})
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
	})

	it("restores every streamed progress chunk without duplicating the message_start seed", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Still working on it." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}

		await harness.fire("message_start", { type: "message_start", message })
		await harness.fire("message_update", {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Still working on it." },
		})
		await harness.fire("message_update", {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " Finished." },
		})
		await harness.fire("message_update", {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: " Finished." },
		})
		const ended = await harness.fire("message_end", { type: "message_end", message })

		expect(ended).toEqual({
			message: expect.objectContaining({ content: [{ type: "text", text: "Still working on it. Finished." }] }),
		})
	})

	it("starts evaluation when the current response settles the Todo list", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "finishing now" }],
			stopReason: "toolUse",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, { status: "complete", completion_confidence: "proven" })
		evaluateFermentV2Mock.mockResolvedValueOnce({
			verdict: "continue",
			reason: "More work is required.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})

		await harness.fire("message_end", { type: "message_end", message })
		await harness.fire("agent_end", { type: "agent_end", messages: [] })

		expect(evaluateFermentV2Mock).toHaveBeenCalledOnce()
	})

	it("does not evaluate a stale hidden candidate after a later active assistant message", async () => {
		await harness.command("ship feature A")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const hiddenMessage = {
			role: "assistant",
			content: [{ type: "text", text: "stale hidden candidate" }],
			stopReason: "toolUse",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: hiddenMessage })
		await harness.fire("message_end", { type: "message_end", message: hiddenMessage })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "add_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{ id: 1, content: "Finish the Ferment V2", status: "completed" },
						{ id: 2, content: "Address evaluator feedback", status: "in_progress" },
					],
					updatedAt: "2026-08-03T00:00:03.000Z",
				},
			},
		})
		const currentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "current visible progress" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: currentMessage })
		const ended = await harness.fire("message_end", { type: "message_end", message: currentMessage })
		const restoredMessage = (ended as { message?: typeof currentMessage } | undefined)?.message ?? currentMessage
		harness.setBranch([...harness.branch, messageEntry(restoredMessage, null)])

		await harness.fire("agent_end", { type: "agent_end", messages: [restoredMessage] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		const evaluatedMessages = JSON.stringify(evaluateFermentV2Mock.mock.calls.at(-1)?.[0].messages)
		expect(evaluatedMessages).toContain("current visible progress")
		expect(evaluatedMessages).not.toContain("stale hidden candidate")
	})

	it("starts replacement accounting with its own turn", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("first")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })

		dateNow.mockReturnValue(61_000)
		await harness.command("second")
		expect(harness.currentFermentV2()).toMatchObject({ objective: "second", timeUsedMs: 0 })

		dateNow.mockReturnValue(121_000)
		await harness.fire("turn_end", terminalTurn())
		expect(harness.currentFermentV2()).toMatchObject({ timeUsedMs: 0 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 121_000 })
		dateNow.mockReturnValue(181_000)
		await harness.fire("turn_end", terminalTurn())
		expect(harness.currentFermentV2()).toMatchObject({ timeUsedMs: 60_000 })
	})

	it("replaces a complete Ferment V2 without confirmation", async () => {
		await harness.command("first")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		await settleFermentV2(harness, "met")
		harness.ui.confirm.mockClear()

		await harness.command("second")

		expect(harness.ui.confirm).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()).toMatchObject({ objective: "second", revision: 1, status: "active" })
	})

	it("reports final elapsed time and tokens", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("ship it")
		expect(harness.ui.setWidget).not.toHaveBeenCalled()

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		dateNow.mockReturnValue(3_500)
		await harness.fire("turn_end", terminalTurn("stop", { input: 1_200, output: 300 }))
		expect(harness.currentFermentV2()).toMatchObject({ tokensUsed: 1_500, timeUsedMs: 2_500 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 3_500 })
		dateNow.mockReturnValue(4_500)
		await completeVisibleTodo(harness)
		const fermentV2 = requireFermentV2(harness.currentFermentV2())
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
			status: "complete",
			completion_confidence: "proven",
		})
		await harness.fire("turn_end", terminalTurn("stop", { input: 200, output: 50 }))
		await settleFermentV2(harness, "met", false)

		expect(harness.currentFermentV2()).toMatchObject({
			status: "active",
			lastEvaluation: { verdict: "met" },
			tokensUsed: 1_750,
			timeUsedMs: 3_500,
		})
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Ferment V2 complete.", "info")
		await finishFinalAnswerTurn(harness, "Delivered final answer.", "stop", { input: 40, output: 10 })
		expect(harness.currentFermentV2()).toMatchObject({
			status: "complete",
			completionConfidence: "proven",
			tokensUsed: 1_750,
			timeUsedMs: 3_500,
		})
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 complete.", "info")
	})

	it.each([
		"aborted",
		"error",
	] as const)("pauses instead of completing when the final answer turn ends with %s", async (stopReason) => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		harness.ui.notify.mockClear()

		await finishFinalAnswerTurn(harness, "Partial final answer.", stopReason)

		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", lastEvaluation: { verdict: "met" } })
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Ferment V2 complete.", "info")
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 paused because its final answer could not be delivered.",
			"warning",
		)
	})

	it("pauses instead of completing when the final answer is empty", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		harness.ui.notify.mockClear()

		await finishFinalAnswerTurn(harness, "   ")

		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", lastEvaluation: { verdict: "met" } })
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Ferment V2 complete.", "info")
	})

	it("buffers accepted final output and removes only its outer whitespace", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "\n\nAccepted answer.\n" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}

		await harness.fire("message_start", { type: "message_start", message })
		const ended = await harness.fire("message_end", { type: "message_end", message })

		expect(message.content).toEqual([{ type: "text", text: "" }])
		expect(ended).toEqual({
			message: expect.objectContaining({ content: [{ type: "text", text: "Accepted answer." }] }),
		})
	})

	it("passes the evaluated draft verbatim to the delivery turn", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = await harness.fire("message_end", { type: "message_end", message })
		const withheld = (ended as { message: typeof message }).message
		harness.setBranch([...harness.branch, messageEntry(withheld, null)])
		evaluateFermentV2Mock.mockResolvedValueOnce({
			verdict: "met",
			reason: "All requirements are evidenced.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})

		await harness.fire("agent_end", {
			type: "agent_end",
			messages: [withheld],
		})
		await harness.fire("agent_settled", { type: "agent_settled" })
		await vi.waitFor(() =>
			expect(harness.sendMessage.mock.calls.some(([sent]) => sent?.details?.source === "evaluation_accepted")).toBe(
				true,
			),
		)

		const delivery = harness.sendMessage.mock.calls.find(
			([sent]) => sent?.details?.source === "evaluation_accepted",
		)?.[0]
		expect(delivery?.content).toContain('Return this evaluated draft verbatim: "Accepted answer."')
	})

	it("does not duplicate a visible accepted draft after status-only Todo settlement", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }],
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }

		expect(ended.message.content).toEqual([{ type: "text", text: "Accepted answer." }])
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		evaluateFermentV2Mock.mockResolvedValueOnce({
			verdict: "met",
			reason: "All requirements are evidenced.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await harness.fire("agent_end", { type: "agent_end", messages: [ended.message] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.currentFermentV2()).toMatchObject({
			status: "active",
			lastEvaluation: { verdict: "met" },
		})
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("Keep a visible, fully completed Todo list")

		harness.sendMessage.mockClear()
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const bookkeeping = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Marking the final Todo done." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: bookkeeping })
		const bookkeepingEnded = (await harness.fire("message_end", { type: "message_end", message: bookkeeping })) as {
			message: typeof bookkeeping
		}
		harness.setBranch([...harness.branch, messageEntry(bookkeepingEnded.message, null)])
		await harness.fire("turn_end", { ...terminalTurn(), message: bookkeepingEnded.message })
		await harness.fire("agent_end", { type: "agent_end", messages: [bookkeepingEnded.message] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(1)
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete" })
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("completes a retained visible accepted draft after status-only Todo settlement without another evaluation", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await modelTodoResult(harness, [
			{
				id: 1,
				content: "Finish the Ferment V2",
				status: "in_progress",
				activeForm: "Finishing",
				note: "Evidence: started",
			},
			{ id: 2, content: "Verify the Ferment V2", status: "pending", activeForm: "Verifying" },
		])
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [
					{
						id: 1,
						content: "Finish the Ferment V2",
						status: "in_progress",
						activeForm: "Finishing",
						note: "Evidence: started",
					},
					{ id: 2, content: "Verify the Ferment V2", status: "pending", activeForm: "Verifying" },
				],
				updatedAt: "2026-08-03T00:00:02.000Z",
			}),
		])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)
		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(1)

		harness.sendMessage.mockClear()
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await modelTodoResult(harness, [
			{ id: 2, content: "Verify the Ferment V2", status: "completed", activeForm: "Verifying" },
			{
				id: 1,
				content: "Finish the Ferment V2",
				status: "completed",
				activeForm: "Finishing",
				note: "Evidence: started",
			},
		])
		const thinkingOnly = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "settled bookkeeping" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: thinkingOnly })
		await harness.fire("message_end", { type: "message_end", message: thinkingOnly })
		await harness.fire("turn_end", { ...terminalTurn(), message: thinkingOnly })
		await harness.fire("agent_end", { type: "agent_end", messages: [thinkingOnly] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(1)
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete" })
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("invalidates a retained accepted draft after substantive tool use", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer before extra work." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "extra work changed the answer basis" }] },
		})
		expect(harness.currentFermentV2()).not.toHaveProperty("lastEvaluation")

		harness.sendMessage.mockClear()
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "completed" }])
		const thinkingOnly = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "settled bookkeeping" }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message: thinkingOnly })
		await harness.fire("message_end", { type: "message_end", message: thinkingOnly })
		await harness.fire("agent_end", { type: "agent_end", messages: [thinkingOnly] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(1)
		expect(harness.sendMessage.mock.lastCall?.[0]?.details?.source).not.toBe("evaluation_accepted")
	})

	it("does not retain a met verdict after Todo reopen", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)

		harness.sendMessage.mockClear()
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "completed" }])
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }])

		expect(harness.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(harness.sendMessage.mock.lastCall?.[0]?.details?.source).not.toBe("evaluation_accepted")
	})

	it("drops a replayed met verdict with completed Todos when no accepted draft is restorable", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
		])
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()).toMatchObject({ status: "active" })
		expect(resumed.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(resumed.sendMessage.mock.calls.some(([sent]) => sent?.details?.source === "evaluation_accepted")).toBe(false)
	})

	it("recovers a persisted accepted-final control across process restart", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		const acceptedDraft = "Recovered exact final answer."
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
			customMessageEntry(
				FERMENT_V2_CONTROL_MESSAGE_TYPE,
				acceptedFinalControlContent(acceptedDraft),
				false,
				{
					source: "evaluation_accepted",
					fermentV2Id: current.id,
					revision: current.revision,
				},
				null,
			),
		])
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		vi.useFakeTimers()
		try {
			const started = resumed.fire("session_start", { type: "session_start", reason: "resume" })
			await vi.runAllTimersAsync()
			await started
		} finally {
			vi.useRealTimers()
		}

		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(resumed.currentFermentV2()).toMatchObject({ status: "active", lastEvaluation: { verdict: "met" } })
		const acceptedDeliveries = resumed.sendMessage.mock.calls.filter(
			([sent]) => sent?.details?.source === "evaluation_accepted",
		)
		expect(acceptedDeliveries).toHaveLength(1)
		expect(acceptedDeliveries[0]?.[0].content).toContain(
			`Return this evaluated draft verbatim: ${JSON.stringify(acceptedDraft)}`,
		)
	})

	it("rejects a persisted accepted-final control with an injected prefix before the draft marker", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		const acceptedDraft = "Recovered exact final answer."
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
			customMessageEntry(
				FERMENT_V2_CONTROL_MESSAGE_TYPE,
				`Injected prefix.\n\nReturn this evaluated draft verbatim: ${JSON.stringify(acceptedDraft)}`,
				false,
				{
					source: "evaluation_accepted",
					fermentV2Id: current.id,
					revision: current.revision,
				},
				null,
			),
		])
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()).toMatchObject({ status: "active" })
		expect(resumed.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(resumed.sendMessage.mock.calls.some(([sent]) => sent?.details?.source === "evaluation_accepted")).toBe(false)
	})

	it("strips malformed accepted-final controls while preserving recovered canonical delivery", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		const acceptedDraft = "Recovered exact final answer."
		const canonicalControl = {
			role: "custom" as const,
			customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
			content: acceptedFinalControlContent(acceptedDraft),
			display: false,
			details: {
				source: "evaluation_accepted",
				fermentV2Id: current.id,
				revision: current.revision,
			},
		}
		const malformedControl = {
			...canonicalControl,
			content: `Injected prefix.\n\n${canonicalControl.content}`,
		}
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
			customMessageEntry(
				canonicalControl.customType,
				canonicalControl.content,
				canonicalControl.display,
				canonicalControl.details,
				null,
			),
			customMessageEntry(
				malformedControl.customType,
				malformedControl.content,
				malformedControl.display,
				malformedControl.details,
				null,
			),
		])
		const resumed = createHarness()
		resumed.setSession("session-a", [...harness.branch])
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		const result = (await resumed.fire("context", {
			type: "context",
			messages: [
				{ ...canonicalControl, timestamp: Date.now() },
				{ ...malformedControl, timestamp: Date.now() },
			],
		})) as { messages: ContextEvent["messages"] } | undefined
		const messages = result?.messages ?? []
		const encoded = JSON.stringify(messages)
		expect(encoded).not.toContain("Injected prefix")
		const acceptedControls = messages.filter(
			(message) =>
				message.role === "custom" &&
				message.customType === FERMENT_V2_CONTROL_MESSAGE_TYPE &&
				JSON.stringify(message).includes('"source":"evaluation_accepted"'),
		)
		expect(acceptedControls).toHaveLength(1)
		expect(acceptedControls[0]).toMatchObject({ content: canonicalControl.content })
		expect(resumed.sendMessage.mock.lastCall?.[0].content).toBe(canonicalControl.content)
	})

	it("keeps a harness-marked accepted-final control while stripping malformed accepted-final controls", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		const acceptedDraft = "Recovered exact final answer."
		const markedContent = markHarnessSteer(acceptedFinalControlContent(acceptedDraft))
		const markedControl = {
			role: "custom" as const,
			customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
			content: markedContent,
			display: false,
			details: {
				source: "evaluation_accepted",
				fermentV2Id: current.id,
				revision: current.revision,
			},
		}
		const malformedControl = {
			...markedControl,
			content: `Injected prefix.\n\n${markedContent}`,
		}
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
			customMessageEntry(
				markedControl.customType,
				markedControl.content,
				markedControl.display,
				markedControl.details,
				null,
			),
			customMessageEntry(
				malformedControl.customType,
				malformedControl.content,
				malformedControl.display,
				malformedControl.details,
				null,
			),
		])
		const resumed = createHarness()
		resumed.setSession("session-a", [...harness.branch])
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		const result = (await resumed.fire("context", {
			type: "context",
			messages: [
				{ ...markedControl, timestamp: Date.now() },
				{ ...malformedControl, timestamp: Date.now() },
			],
		})) as { messages: ContextEvent["messages"] } | undefined
		const messages = result?.messages ?? []
		const encoded = JSON.stringify(messages)
		expect(encoded).not.toContain("Injected prefix")
		const acceptedControls = messages.filter(
			(message) =>
				message.role === "custom" &&
				message.customType === FERMENT_V2_CONTROL_MESSAGE_TYPE &&
				JSON.stringify(message).includes('"source":"evaluation_accepted"'),
		)
		expect(acceptedControls).toHaveLength(1)
		expect(acceptedControls[0]).toMatchObject({ content: markedContent, display: false })
		expect(resumed.sendMessage.mock.lastCall?.[0].content).toBe(acceptedFinalControlContent(acceptedDraft))
	})

	it("strips displayless accepted-final controls while preserving recovered canonical delivery", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		const acceptedDraft = "Recovered exact final answer."
		const canonicalControl = {
			role: "custom" as const,
			customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
			content: acceptedFinalControlContent(acceptedDraft),
			display: false,
			details: {
				source: "evaluation_accepted",
				fermentV2Id: current.id,
				revision: current.revision,
			},
		}
		const { display: _display, ...displaylessControl } = canonicalControl
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:03.000Z",
			}),
			customMessageEntry(
				canonicalControl.customType,
				canonicalControl.content,
				canonicalControl.display,
				canonicalControl.details,
				null,
			),
			customMessageEntry(
				displaylessControl.customType,
				displaylessControl.content,
				undefined,
				displaylessControl.details,
				null,
			),
		])
		const resumed = createHarness()
		resumed.setSession("session-a", [...harness.branch])
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		const result = (await resumed.fire("context", {
			type: "context",
			messages: [
				{ ...canonicalControl, timestamp: Date.now() },
				{ ...displaylessControl, timestamp: Date.now() },
			],
		})) as { messages: ContextEvent["messages"] } | undefined
		const messages = result?.messages ?? []
		const acceptedControls = messages.filter(
			(message) =>
				message.role === "custom" &&
				message.customType === FERMENT_V2_CONTROL_MESSAGE_TYPE &&
				JSON.stringify(message).includes('"source":"evaluation_accepted"'),
		)
		expect(acceptedControls).toHaveLength(1)
		expect(acceptedControls[0]).toMatchObject({ content: canonicalControl.content, display: false })
		expect(resumed.sendMessage.mock.lastCall?.[0].content).toBe(canonicalControl.content)
	})

	it("drops a retained accepted draft across same-session tree replay", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Branch-local accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)
		expect(harness.currentFermentV2()).toMatchObject({ lastEvaluation: { verdict: "met" } })

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()).not.toHaveProperty("lastEvaluation")
	})

	it.each([
		{
			name: "adds a Todo",
			todos: [
				{ id: 1, content: "Finish the Ferment V2", status: "completed" },
				{ id: 2, content: "Verify the Ferment V2", status: "completed" },
			],
		},
		{ name: "removes a Todo", todos: [] },
		{
			name: "changes content",
			todos: [{ id: 1, content: "Finish the Ferment V2 plus new requirement", status: "completed" }],
		},
		{
			name: "changes activeForm",
			todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed", activeForm: "New active form" }],
		},
		{
			name: "changes note",
			todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed", note: "Evidence: new note" }],
		},
		{
			name: "duplicates a Todo id",
			todos: [
				{ id: 1, content: "Finish the Ferment V2", status: "completed" },
				{ id: 1, content: "Finish the Ferment V2", status: "completed" },
			],
		},
	] satisfies Array<{
		name: string
		todos: TodoItem[]
	}>)("invalidates a retained accepted draft when a model Todo result $name", async ({ todos }) => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "in_progress" }])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)

		harness.sendMessage.mockClear()
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await modelTodoResult(harness, todos)

		expect(harness.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(harness.sendMessage.mock.lastCall?.[0]?.details?.source).not.toBe("evaluation_accepted")
	})

	it("drops a draftless accepted final answer instead of restoring generic delivery", async () => {
		await harness.command("ship it")
		const current = harness.currentFermentV2()
		if (!current) throw new Error("expected active Ferment V2")
		harness.setBranch([
			...harness.branch,
			customEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, {
				schemaVersion: 1,
				op: "put",
				fermentV2: {
					...current,
					evaluationCount: 1,
					lastEvaluation: {
						verdict: "met",
						reason: "All requirements are evidenced.",
						evaluatedAt: "2026-08-03T00:00:03.000Z",
					},
				},
			}),
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:02.000Z",
			}),
		])
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()).toMatchObject({ status: "active" })
		expect(resumed.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(resumed.sendMessage.mock.calls.some(([sent]) => sent?.details?.source === "evaluation_accepted")).toBe(false)
	})

	it("retries accepted final-answer delivery after pause and resume", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)

		await harness.command("pause")
		harness.sendMessage.mockClear()
		await harness.command("resume")

		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "evaluation_accepted" }),
		})
		await finishFinalAnswerTurn(harness, "Delivered after retry.")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete" })
	})

	it("retries final-answer delivery after a failed delivery turn", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer before failed delivery." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain(
			'Return this evaluated draft verbatim: "Accepted answer before failed delivery."',
		)
		await finishFinalAnswerTurn(harness, "Partial answer.", "error")
		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", lastEvaluation: { verdict: "met" } })

		harness.sendMessage.mockClear()
		await harness.command("resume")
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "evaluation_accepted" }),
		})
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain(
			'Return this evaluated draft verbatim: "Accepted answer before failed delivery."',
		)
		await finishFinalAnswerTurn(harness, "Delivered after failure.")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete" })
	})

	it("drops a paused met verdict after replay loses the accepted draft", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Accepted answer before failed delivery." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })
		const ended = (await harness.fire("message_end", { type: "message_end", message })) as { message: typeof message }
		harness.setBranch([...harness.branch, messageEntry(ended.message, null)])
		await settleFermentV2(harness, "met", false)
		await finishFinalAnswerTurn(harness, "Partial answer.", "error")
		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", lastEvaluation: { verdict: "met" } })
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()).toMatchObject({ status: "paused" })
		expect(resumed.currentFermentV2()).not.toHaveProperty("lastEvaluation")

		await resumed.command("resume")

		expect(resumed.currentFermentV2()).toMatchObject({ status: "active" })
		expect(resumed.sendMessage.mock.calls.some(([sent]) => sent?.details?.source === "evaluation_accepted")).toBe(false)
	})

	it("blocks tools while delivering an accepted final answer", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })

		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
			reason: expect.stringContaining("final answer"),
		})
		await finishFinalAnswerTurn(harness, "Delivered without tools.")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete" })
	})

	it("invalidates accepted final-answer delivery when the user changes Todos", async () => {
		registerTodosCommand(harness.pi)
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		expect(harness.currentFermentV2()).toMatchObject({ lastEvaluation: { verdict: "met" } })

		await harness.runCommand("todos", "add Verify the changed result")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })

		expect(harness.currentFermentV2()).not.toHaveProperty("lastEvaluation")
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
	})

	it.each([
		"queued",
		"active",
	] as const)("preserves %s final-answer delivery across same-session replay", async (phase) => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:02.000Z",
			}),
		])
		await settleFermentV2(harness, "met", false)
		if (phase === "active") {
			await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		}

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })
		if (phase === "queued") {
			await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		}

		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toMatchObject({
			block: true,
			reason: expect.stringContaining("final answer"),
		})
	})

	it.each([
		"pause",
		"edit",
		"clear",
	] as const)("removes an already queued final-answer control after %s", async (action) => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await settleFermentV2(harness, "met", false)
		const finalControl = harness.sendMessage.mock.calls.find(
			([message]) => message?.details?.source === "evaluation_accepted",
		)?.[0]
		if (!finalControl) throw new Error("expected queued final-answer control")

		await harness.command(action === "edit" ? "edit revised objective" : action)
		const originalMessages: ContextEvent["messages"] = [{ role: "custom", ...finalControl, timestamp: Date.now() }]
		const result = (await harness.fire("context", {
			type: "context",
			messages: originalMessages,
		})) as { messages: ContextEvent["messages"] } | undefined

		expect(JSON.stringify(result?.messages ?? originalMessages)).not.toContain(
			"The objective is complete and ready for user delivery",
		)
	})

	it("treats missing usage fields as zero", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.fire("turn_end", terminalTurn("stop", { input: 25 }))

		expect(harness.currentFermentV2()?.tokensUsed).toBe(25)
	})

	it("allows work tools but requires visible settled todos before ending every Ferment V2 revision", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })

		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", { type: "tool_call", toolName: GET_FERMENT_V2_TOOL_NAME, input: {} }),
		).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "blocked", reason: "needs user input" },
			}),
		).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
					todos: [{ id: 1, content: "Implement the Ferment V2", status: "in_progress" }],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
					todos: [{ id: 1, content: "Implement the Ferment V2", status: "completed" }],
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("without clearing") })

		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })
		await harness.command("another session Ferment V2")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		expect(await harness.fire("tool_call", { type: "tool_call", toolName: "bash", input: {} })).toBeUndefined()
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })

		await harness.command("edit changed objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true })
	})

	it("ignores todo results from a non-visible scope", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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

		expect(harness.currentFermentV2()).toMatchObject({ objective: "concurrent", revision: 2 })
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"The Ferment V2 changed while the editor was open. Reopen /ferment-v2 edit to edit the current revision.",
			"warning",
		)
	})

	it("updates the active revision without cancelling the current turn", async () => {
		await harness.command("original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.setIdle(false)
		harness.sendMessage.mockClear()
		harness.waitForIdle.mockImplementationOnce(() => new Promise<void>(() => undefined))

		await harness.command("edit revised")

		expect(harness.abort).not.toHaveBeenCalled()
		expect(harness.waitForIdle).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()).toMatchObject({ objective: "revised", revision: 2, status: "active" })
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.sendMessage.mock.lastCall?.[0]?.details).toMatchObject({ source: "edit", revision: 2 })

		await harness.fire("turn_end", terminalTurn("stop"))

		expect(harness.currentFermentV2()).toMatchObject({ objective: "revised", revision: 2, status: "active" })
		expect(harness.ui.notify).not.toHaveBeenCalledWith(
			"Ferment V2 paused because the agent turn was cancelled.",
			"warning",
		)
	})

	it("finishes and accounts a superseded turn without evaluating it as the edited revision", async () => {
		await harness.command("--tokens 100 original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Revision one finished its running operation." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("message_start", { type: "message_start", message })

		await harness.command("edit revised")
		const ended = await harness.fire("message_end", { type: "message_end", message })
		await harness.fire("turn_end", terminalTurn("stop", { input: 60, output: 39 }))
		evaluateFermentV2Mock.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [message] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(ended).toMatchObject({ message: { content: [] } })
		expect(harness.currentFermentV2()).toMatchObject({
			objective: "revised",
			revision: 2,
			status: "active",
			tokensUsed: 99,
		})
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
	})

	it("waits before a user Todo mutation and resumes from the updated list", async () => {
		registerTodosCommand(harness.pi)
		await harness.command("ship it")
		const details = applyWriteTodos(
			{ todos: [{ content: "Keep until the user clears it", status: "in_progress" }] },
			"session-a",
		)
		harness.appendEntry(TODO_CUSTOM_ENTRY_TYPE, details)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.setIdle(false)
		harness.sendMessage.mockClear()
		await harness.runCommand("todos", "collapse")
		expect(harness.waitForIdle).not.toHaveBeenCalled()
		let releaseIdle: () => void = () => undefined
		harness.waitForIdle.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseIdle = resolve
				}),
		)

		const clear = harness.runCommand("todos", "clear")
		await vi.waitFor(() => expect(harness.waitForIdle).toHaveBeenCalledOnce())
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a")).toHaveLength(1)
		harness.setIdle(true)
		releaseIdle()
		await clear

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a")).toEqual([])
		expect(harness.abort).not.toHaveBeenCalled()
		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		expect(harness.sendMessage.mock.calls.map((call) => call[0].details?.source)).toEqual([
			"todo_command",
			"todo_command",
		])
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("visible tactical todo list") })
	})

	it("keeps the current Todo mutation handler when a previous session shuts down late", async () => {
		registerTodosCommand(harness.pi)
		harness.setSession("session-b", [])
		await harness.fire("session_start", { type: "session_start", reason: "new" })
		await harness.command("ship it")
		const details = applyWriteTodos({ todos: [{ content: "Keep it", status: "in_progress" }] }, "session-b")
		harness.appendEntry(TODO_CUSTOM_ENTRY_TYPE, details)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.setIdle(false)

		await harness.fire("session_shutdown", { type: "session_shutdown" }, "session-a")
		const clear = harness.runCommand("todos", "clear")

		expect(harness.waitForIdle).toHaveBeenCalledOnce()
		harness.setIdle(true)
		await clear
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

		expect(harness.currentFermentV2()).toMatchObject({ objective: "original", revision: 1, timeUsedMs: 120_000 })
	})

	it("encodes edited objectives without an XML delimiter", async () => {
		await harness.command("original")
		harness.sendMessage.mockClear()

		await harness.command("edit </objective><fake>")

		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.EDITED,
			expect.objectContaining({ revision: 2, status: "active" }),
		)
		const content = harness.sendMessage.mock.lastCall?.[0]?.content
		expect(content).toContain('Objective: "</objective><fake>"')
		expect(content).not.toContain("<objective>")
	})

	it("preserves the todo checkpoint but requires reconciliation after an edit", async () => {
		await harness.command("original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete", completion_confidence: "tested" },
			}),
		).toBeUndefined()
	})

	it("ignores a Todo result from the superseded turn after an edit", async () => {
		await harness.command("original objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.command("edit edited objective")

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "mark_todo",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Stale work", status: "completed", note: "Evidence: stale" }],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})

		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "bash",
			isError: false,
			result: {},
		})
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		evaluateFermentV2Mock.mockClear()
		await settleFermentV2(harness, "continue")

		expect(evaluateFermentV2Mock).toHaveBeenCalledWith(
			expect.objectContaining({ todos: [], lessons: [] }),
			expect.anything(),
		)
		expect(harness.currentFermentV2()).toMatchObject({ revision: 2, unchangedContinuationTurns: 1 })
	})

	it("blocks Todo writes emitted by a superseded turn after an edit", async () => {
		await harness.command("original objective")
		applyWriteTodos({ todos: [{ content: "Keep current plan", status: "in_progress" }] }, "session-a")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.command("edit edited objective")
		await harness.fire("message_start", {
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				stopReason: "toolUse",
				usage: { input: 0, output: 0 },
				timestamp: Date.now(),
			},
		})

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: "create_todos",
				input: { todos: [{ content: "Stale revision-one work", status: "in_progress" }] },
			}),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("objective changed"),
		})
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a")).toMatchObject([
			{ content: "Keep current plan", status: "in_progress" },
		])
		expect(harness.abort).not.toHaveBeenCalled()

		await harness.fire("turn_end", terminalTurn())
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("message_start", {
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				stopReason: "toolUse",
				usage: { input: 0, output: 0 },
				timestamp: Date.now(),
			},
		})
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: "create_todos",
				input: { todos: [{ content: "Current revision work", status: "in_progress" }] },
			}),
		).toBeUndefined()
	})

	it("accounts a superseded turn without applying its interruption to the edited revision", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("original objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })

		dateNow.mockReturnValue(2_000)
		await harness.command("edit edited objective")
		expect(harness.currentFermentV2()).toMatchObject({
			revision: 2,
			status: "active",
			tokensUsed: 0,
			timeUsedMs: 1_000,
		})

		dateNow.mockReturnValue(5_000)
		await harness.fire("turn_end", terminalTurn("aborted", { input: 80, output: 20 }))
		expect(harness.currentFermentV2()).toMatchObject({
			revision: 2,
			status: "active",
			tokensUsed: 100,
			timeUsedMs: 4_000,
		})

		evaluateFermentV2Mock.mockClear()
		await settleFermentV2(harness, "continue")
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()).toMatchObject({ revision: 2, status: "active" })
		expect(harness.currentFermentV2()?.consecutiveErrorTurns).toBeUndefined()
	})

	it("pauses, resumes, clears, and restores the clear tombstone", async () => {
		await harness.command("ship it")
		harness.setIdle(false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.command("pause")
		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
				details: expect.objectContaining({ source: "pause" }),
			}),
			expect.objectContaining({ deliverAs: "steer", triggerTurn: true }),
		)
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.PAUSED,
			expect.objectContaining({ reason: "user", status: "paused" }),
		)
		const sentAfterPause = harness.sendMessage.mock.calls.length
		await harness.fire("turn_end", terminalTurn())
		expect(harness.sendMessage).toHaveBeenCalledTimes(sentAfterPause)

		await harness.command("resume")
		expect(harness.currentFermentV2()?.status).toBe("active")
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "resume" }),
		})

		harness.sendMessage.mockClear()
		await harness.command("clear")
		expect(harness.currentFermentV2()).toBeUndefined()
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
				details: expect.objectContaining({ source: "clear" }),
			}),
			expect.objectContaining({ deliverAs: "steer", triggerTurn: true }),
		)
		expect(harness.latestJournal()).toMatchObject({ op: "clear" })

		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		expect(harness.currentFermentV2()).toBeUndefined()
		expect((await harness.tool(GET_FERMENT_V2_TOOL_NAME, {})).details.fermentV2).toBeNull()
	})

	it("schedules a continuation turn when resuming a session with an active Ferment V2", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()?.status).toBe("active")
		expect(resumed.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: FERMENT_V2_CONTROL_MESSAGE_TYPE }),
			expect.objectContaining({ triggerTurn: true }),
		)
	})

	it("does not compete with the incoming prompt when a headless session resumes", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness({ hasUI: false })
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()?.status).toBe("active")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
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

	it("does not schedule a continuation turn when resuming a non-active Ferment V2", async () => {
		await harness.command("ship it")
		harness.setIdle(false)
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.command("pause")
		expect(harness.currentFermentV2()?.status).toBe("paused")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()?.status).toBe("paused")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

	it("does not schedule a continuation turn on resume when a user message is already pending", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		resumed.setPending(true)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()?.status).toBe("active")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

	it("does not schedule a continuation turn on resume when the session is already busy", async () => {
		await harness.command("ship it")
		const capturedBranch = [...harness.branch]

		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		resumed.setIdle(false)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })

		expect(resumed.currentFermentV2()?.status).toBe("active")
		expect(resumed.sendMessage).not.toHaveBeenCalled()
	})

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
				expect.objectContaining({ customType: FERMENT_V2_CONTROL_MESSAGE_TYPE }),
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

		const result = await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})

		expect(result.content[0].text).toBe("Recorded. Stop here.")
		expect(result.terminate).toBe(true)
		expect(harness.currentFermentV2()?.status).toBe("active")
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()?.status).toBe("complete")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.COMPLETED,
			expect.objectContaining({ completionConfidence: "tested", status: "complete" }),
		)
	})

	it("accepts a completion claim without self-reported confidence", async () => {
		await harness.command("prove it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		const missing = await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, { status: "complete" })
		expect(missing.terminate).toBe(true)
		expect(harness.currentFermentV2()?.status).toBe("active")
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()?.status).toBe("complete")
		expect(harness.currentFermentV2()?.completionConfidence).toBeUndefined()
	})

	it("keeps low self-reported confidence without treating it as the verdict", async () => {
		await harness.command("prove it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		const partial = await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
			completion_confidence: "partial",
		})
		expect(partial.terminate).toBe(true)
		expect(harness.currentFermentV2()?.status).toBe("active")
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete", completionConfidence: "partial" })
	})

	it("rejects stale and invalid model updates while accepting both terminal statuses", async () => {
		await harness.command("original")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await harness.command("edit changed")

		const stale = await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
		})
		expect(stale.content[0].text).toContain("Ferment V2 changed or stopped during this turn")
		expect(harness.currentFermentV2()?.status).toBe("active")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const invalid = await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "paused",
		})
		expect(invalid.content[0].text).toContain("invalid terminal status")

		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "blocked",
			reason: "needs user input",
		})
		expect(harness.currentFermentV2()).toMatchObject({ status: "blocked", blockedReason: "needs user input" })
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.BLOCKED,
			expect.objectContaining({ status: "blocked" }),
		)

		await harness.command("resume")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()?.status).toBe("complete")
	})

	it("injects one authoritative Ferment V2 context and removes stale snapshots", async () => {
		await harness.command("handle </objective> safely")
		const oldFermentV2Message = {
			role: "custom" as const,
			customType: FERMENT_V2_CONTEXT_MESSAGE_TYPE,
			content: [{ type: "text" as const, text: "stale" }],
			display: false,
			details: {},
			timestamp: 1,
		}
		const other = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 2 }

		const result = (await harness.fire("context", {
			type: "context",
			messages: [oldFermentV2Message, other],
		})) as { messages: ContextEvent["messages"] }
		const fermentV2Messages = result.messages.filter(
			(message) => message.role === "custom" && message.customType === FERMENT_V2_CONTEXT_MESSAGE_TYPE,
		)

		expect(fermentV2Messages).toHaveLength(1)
		expect(JSON.stringify(fermentV2Messages[0])).toContain("handle </objective> safely")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("map every explicit objective requirement")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("survive compaction")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("Do not call get_ferment_v2 while this context is present")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("separately supplied Todo state")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("do not narrate internal checks, policies, or bookkeeping")
		expect(JSON.stringify(fermentV2Messages[0])).toContain("give the concrete outcome and evidence")
		expect(JSON.stringify(fermentV2Messages[0])).not.toContain("final answer is requested separately")
		expect(JSON.stringify(fermentV2Messages[0])).not.toContain('\\"todos\\"')
		expect(JSON.stringify(fermentV2Messages[0])).not.toContain("tokensUsed")
		expect(JSON.stringify(fermentV2Messages[0])).not.toContain("timeUsedMs")
		expect(result.messages[0]).toBe(fermentV2Messages[0])
		expect(result.messages).toContain(other)
	})

	it("keeps the Ferment V2 context stable while only accounting changes", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("keep the handoff stable")
		const userMessage = { role: "user" as const, content: [{ type: "text" as const, text: "start" }], timestamp: 1 }
		const first = (await harness.fire("context", {
			type: "context",
			messages: [userMessage],
		})) as { messages: ContextEvent["messages"] }
		const firstFermentV2Index = first.messages.findIndex(
			(message) => message.role === "custom" && message.customType === FERMENT_V2_CONTEXT_MESSAGE_TYPE,
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

		expect(second.messages[firstFermentV2Index]).toEqual(first.messages[firstFermentV2Index])
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
		evaluateFermentV2Mock.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("continues after automatic compaction between agent_end and agent_settled", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		const compaction = compactionEntry("compacted work")
		harness.setBranch([...harness.branch, compaction])
		await harness.fire("session_compact", {
			type: "session_compact",
			compactionEntry: compaction,
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		})
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", evaluationCount: 1 })
		expect(harness.sendMessage.mock.lastCall?.[0]).toMatchObject({
			details: expect.objectContaining({ source: "evaluation", revision: 1 }),
		})
	})

	it("defers a settled continuation until an interactive prompt can claim the gap", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		const { release, settled } = await holdEvaluation(harness)
		queueMicrotask(() => harness.setIdle(false))
		release({
			verdict: "continue",
			reason: "More work is required.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("evaluates the selected session branch instead of only the latest AgentEnd messages", async () => {
		await harness.command("prove the objective")
		const root = harness.branch.at(-1)
		if (!root) throw new Error("expected Ferment V2 journal root")
		const priorEvidence = messageEntry(
			{
				role: "toolResult",
				toolCallId: "old-tool",
				toolName: "bash",
				content: [{ type: "text", text: "retained evidence from an earlier turn" }],
				isError: false,
				timestamp: Date.now(),
			},
			root.id,
		)
		const latestMessage = messageEntry(
			{
				role: "assistant",
				content: [{ type: "text", text: "latest turn" }],
				stopReason: "stop",
				usage: { input: 1, output: 1 },
				timestamp: Date.now(),
			},
			priorEvidence.id,
		)
		harness.setBranch([...harness.branch, priorEvidence, latestMessage])
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		evaluateFermentV2Mock.mockClear()

		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(evaluateFermentV2Mock).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: "toolResult",
						content: [{ type: "text", text: "retained evidence from an earlier turn" }],
					}),
				]),
			}),
			expect.anything(),
		)
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
		expect(harness.currentFermentV2()?.evaluationCount).toBeUndefined()
	})

	it("keeps evaluator met active until the current revision has a completed visible Todo", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()).toMatchObject({
			status: "active",
			evaluationCount: 1,
			lastEvaluation: { verdict: "met" },
		})
		expect(harness.sendMessage.mock.lastCall?.[0].content).toContain("Create a visible Todo list now")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		harness.appendEntry.mockClear()
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete", evaluationCount: 2 })
		expect(harness.appendEntry).toHaveBeenCalledTimes(2)
		expect(harness.appendEntry.mock.calls[0]?.[1]).toMatchObject({
			fermentV2: { status: "active", lastEvaluation: { verdict: "met" } },
		})
		expect(harness.appendEntry.mock.calls[1]?.[1]).toMatchObject({ fermentV2: { status: "complete" } })
	})

	it("does not require an invisible Todo list for evidenced headless completion", async () => {
		const headless = createHarness({ hasUI: false })
		const command = headless.command("ship it")
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())
		await headless.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await settleFermentV2(headless, "met")

		expect(headless.currentFermentV2()).toMatchObject({ status: "complete", evaluationCount: 1 })
		await command
	})

	it("bounds repeated completion checks when the visible Todo list stays empty", async () => {
		await harness.command("ship it")
		harness.sendMessage.mockClear()

		const verdicts: Array<"met" | "continue"> = ["met", "continue", "met"]
		for (const [index, verdict] of verdicts.entries()) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex: index + 1, timestamp: Date.now() })
			await settleFermentV2(harness, verdict)
		}

		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(3)
		expect(harness.currentFermentV2()).toMatchObject({
			status: "paused",
			evaluationCount: 3,
			unchangedContinuationTurns: 3,
		})
		expect(continuations(harness)).toHaveLength(2)
		expect(continuations(harness)[0]?.content).toContain("Create a visible Todo list now")
	})

	it("blocks on impossible and preserves the evaluator reason without telemetering it", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		evaluateFermentV2Mock.mockResolvedValueOnce({
			verdict: "impossible",
			reason: "Needs a user-owned credential.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		harness.appendEntry.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentFermentV2()).toMatchObject({
			status: "blocked",
			blockedReason: "Needs a user-owned credential.",
			lastEvaluation: { verdict: "impossible", reason: "Needs a user-owned credential." },
		})
		expect(harness.events.emit).toHaveBeenCalledWith(
			FERMENT_V2_EVENTS.EVALUATED,
			expect.not.objectContaining({ reason: expect.anything() }),
		)
		expect(harness.appendEntry).toHaveBeenCalledOnce()

		await harness.command("resume")
		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()).not.toHaveProperty("blockedReason")
	})

	it("pauses resumably when the evaluator is unavailable", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.appendEntry.mockClear()
		await settleFermentV2(harness, "unavailable")

		expect(harness.currentFermentV2()).toMatchObject({
			status: "paused",
			evaluationCount: 1,
			lastEvaluation: { verdict: "unavailable", reason: "No evaluator model is available." },
		})
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused: No evaluator model is available.", "warning")
		expect(harness.appendEntry).toHaveBeenCalledTimes(1)
	})

	it("keeps evaluation details out of the transcript", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		await settleFermentV2(harness, "continue")
		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(continuations(harness)).toHaveLength(1)
		expect(continuations(harness)[0]?.content).toContain("Remaining task gap: More work is required.")
		expect(continuations(harness)[0]?.content).not.toMatch(/\bevaluator\b|independent completion check/i)

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		await settleFermentV2(harness, "impossible")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("counts substantive tool use only while the Ferment V2 is active", async () => {
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
		await settleFermentV2(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress" }),
		)
	})

	it("stalls an agent that keeps claiming completion without new work", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, { status: "complete", completion_confidence: "proven" })
			await settleFermentV2(harness, "continue")
		}

		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress" }),
		)
	})

	it("keeps the completion claim across a continue verdict", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, { status: "complete", completion_confidence: "proven" })

		await settleFermentV2(harness, "continue")
		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleFermentV2(harness, "met")
		expect(harness.currentFermentV2()).toMatchObject({ status: "complete", completionConfidence: "proven" })
	})

	it("reports each evaluation's own usage", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")

		const evaluated = harness.events.emit.mock.calls.filter(([name]) => name === FERMENT_V2_EVENTS.EVALUATED)
		expect(evaluated).toHaveLength(2)
		for (const [, payload] of evaluated) expect(payload).toMatchObject({ usage: EVALUATOR_USAGE })
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

	it("blocks a headless edit until the Ferment V2 reaches a terminal state", async () => {
		const headless = createHarness({ hasUI: false })
		const create = headless.command("ship it")
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())

		let editResolved = false
		const edit = headless.command("edit ship it properly").then(() => {
			editResolved = true
		})
		await vi.waitFor(() => expect(headless.currentFermentV2()?.revision).toBe(2))
		expect(editResolved).toBe(false)

		await settleFermentV2(headless, "unavailable")
		await Promise.all([create, edit])
		expect(editResolved).toBe(true)
	})

	it("does not start a coding-agent turn when paused while only the evaluator is deciding", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		harness.setIdle(true)

		const { release, settled, signal } = await holdEvaluation(harness)

		const pause = harness.command("pause")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		expect(harness.sendMessage).not.toHaveBeenCalled()

		release({ verdict: "continue", reason: "More work is required.", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await Promise.all([pause, settled])
		expect(harness.currentFermentV2()?.status).toBe("paused")
	})

	it("does not start a coding-agent turn when cleared while only the evaluator is deciding", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()
		harness.setIdle(true)

		const { release, settled, signal } = await holdEvaluation(harness)

		const clear = harness.command("clear")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		expect(harness.sendMessage).not.toHaveBeenCalled()

		release({ verdict: "continue", reason: "More work is required.", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await Promise.all([clear, settled])
		expect(harness.currentFermentV2()).toBeUndefined()
	})

	it("drops a late evaluator result after pause and resume", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.setIdle(true)
		const { release, settled, signal } = await holdEvaluation(harness)

		const pause = harness.command("pause")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		release({ verdict: "continue", reason: "late result", model: "test/evaluator", usage: EVALUATOR_USAGE })
		await Promise.all([pause, settled])
		expect(signal?.aborted).toBe(true)
		await harness.command("resume")
		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.evaluationCount).toBeUndefined()
	})

	it("refuses to resume when required Ferment V2 or Todo tools are unavailable", async () => {
		await harness.command("ship it")
		await harness.command("pause")
		harness.sendMessage.mockClear()
		harness.setActiveTools([...FERMENT_V2_TOOL_NAMES])

		await harness.command("resume")

		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 requires the Ferment V2 and Todo tools to be enabled before it can run.",
			"warning",
		)
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Ferment V2 resumed.", "info")
	})

	it("resumes when only the recovery getter is hidden", async () => {
		await harness.command("ship it")
		await harness.command("pause")
		harness.sendMessage.mockClear()
		harness.ui.notify.mockClear()
		harness.setActiveTools([UPDATE_FERMENT_V2_TOOL_NAME, ...TODO_TOOL_NAMES])

		await harness.command("resume")

		expect(harness.currentFermentV2()?.status).toBe("active")
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 resumed.", "info")
	})

	it("discards an evaluator result for a stale Ferment V2 revision", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		const edit = harness.command("edit new objective")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await Promise.all([edit, settled])

		expect(harness.currentFermentV2()).toMatchObject({ revision: 2, objective: "new objective" })
		expect(harness.currentFermentV2()?.evaluationCount).toBeUndefined()
	})

	it("cancels an in-flight evaluation when the Ferment V2 is replaced", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		harness.ui.confirm.mockResolvedValueOnce(true)
		const replacement = harness.command("new objective")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await Promise.all([replacement, settled])
	})

	it("cancels an in-flight evaluation when the Ferment V2 is edited", async () => {
		await harness.command("old objective")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const { release, settled, signal } = await holdEvaluation(harness)

		const edit = harness.command("edit new objective")
		await vi.waitFor(() => expect(signal?.aborted).toBe(true))
		release({
			verdict: "continue",
			reason: "old result",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await Promise.all([edit, settled])
	})

	it("aborts an evaluation held across a session_tree rewind that lands on the same Ferment V2 revision", async () => {
		await harness.command("ship it")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.setBranch([
			...harness.branch,
			customEntry(TODO_CUSTOM_ENTRY_TYPE, {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content: "Finish the Ferment V2", status: "completed" }],
				updatedAt: "2026-08-03T00:00:01.000Z",
			}),
		])

		const { release, settled, signal } = await holdEvaluation(harness)

		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "before", newLeafId: "after" })

		expect(signal?.aborted).toBe(true)

		release({
			verdict: "met",
			reason: "All requirements are evidenced.",
			model: "test/evaluator",
			usage: EVALUATOR_USAGE,
		})
		await settled

		expect(harness.currentFermentV2()?.status).not.toBe("complete")
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
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Do the work", status: "in_progress", activeForm: "Working", note: "No progress" }],
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
								note: "No progress",
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
			expect(harness.appendEntry).toHaveBeenCalledOnce()
		}

		const continued = continuations(harness)
		expect(continued).toHaveLength(2)
		expect(continued[1]?.content).toContain("Reassess the current evidence and dead ends")
		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 3 stalled continuation turns.", "warning")
	})

	it("pauses after three repeated evaluation gaps despite substantive tool use", async () => {
		await harness.command("keep going")

		for (let turnIndex = 1; turnIndex <= 4; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName: "read",
				toolCallId: `call-${turnIndex}`,
				isError: false,
				result: {},
			})
			await settleFermentV2(harness, "continue")
		}

		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 3 stalled continuation turns.", "warning")
	})

	it("resets repeated-gap progress when substantive work changes the evaluator gap", async () => {
		await harness.command("keep going")

		for (let turnIndex = 1; turnIndex <= 2; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("tool_execution_end", {
				type: "tool_execution_end",
				toolName: "read",
				toolCallId: `call-${turnIndex}`,
				isError: false,
				result: {},
			})
			await settleFermentV2(harness, "continue")
		}

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 1 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "call-3",
			isError: false,
			result: {},
		})
		await settleFermentV2(harness, "continue", true, "A different requirement remains.")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBeUndefined()
	})

	it("pauses after three no-progress continuation turns split across a session restart", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleFermentV2(resumed, "continue")

		expect(resumed.currentFermentV2()?.status).toBe("paused")
		expect(resumed.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
			expect.objectContaining({ reason: "no_progress", continuationCount: 3, status: "paused" }),
		)
	})

	it("pauses when every turn only appends a fresh not-yet-started todo", async () => {
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
			await settleFermentV2(harness, "continue")
		}

		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.STALLED,
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
		await settleFermentV2(harness, "continue")

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
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

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
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBeUndefined()
	})

	it("counts settling a todo as progress and resets the no-progress counter", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
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
			await settleFermentV2(harness, "continue")
		}

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

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
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBeUndefined()
	})

	it.each([
		{ field: "content", value: "Do the remaining work" },
		{ field: "activeForm", value: "Still working" },
		{ field: "note", value: "revised" },
	] as const)("counts active Todo $field revisions as progress", async ({ field, value }) => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
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

		for (let turnIndex = 1; turnIndex <= 2; turnIndex += 1) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn())
			await settleFermentV2(harness, "continue")
		}
		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "update_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "Do the work", status: "in_progress", activeForm: "Working", [field]: value }],
					updatedAt: "2026-08-03T00:00:03.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBeUndefined()
	})

	it("does not count reordering unchanged Todos or lessons as progress", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "create_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{ id: 1, content: "Active item", status: "in_progress", activeForm: "Working on active item" },
						{ id: 2, content: "First settled item", status: "completed", note: "Evidence: first check passed" },
						{ id: 3, content: "Second settled item", status: "completed", note: "Evidence: second check passed" },
					],
					updatedAt: "2026-08-03T00:00:00.000Z",
				},
			},
		})

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "update_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
					scope: { kind: "global" },
					todos: [
						{ id: 3, content: "Second settled item", status: "completed", note: "Evidence: second check passed" },
						{ id: 2, content: "First settled item", status: "completed", note: "Evidence: first check passed" },
						{ id: 1, content: "Active item", status: "in_progress", activeForm: "Working on active item" },
					],
					updatedAt: "2026-08-03T00:00:01.000Z",
				},
			},
		})
		await harness.fire("turn_end", terminalTurn())
		await settleFermentV2(harness, "continue")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBe(1)
	})

	it("does not loop when Ferment V2 tools are hidden", async () => {
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		harness.setActiveTools([])
		evaluateFermentV2Mock.mockClear()
		harness.appendEntry.mockClear()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()?.status).toBe("active")
		expect(harness.currentFermentV2()?.evaluationCount).toBeUndefined()
	})

	it("continues and completes when only the recovery tool is hidden", async () => {
		await harness.command("finish")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await completeVisibleTodo(harness)
		await harness.tool(UPDATE_FERMENT_V2_TOOL_NAME, {
			status: "complete",
			completion_confidence: "tested",
		})

		harness.setActiveTools([UPDATE_FERMENT_V2_TOOL_NAME, ...TODO_TOOL_NAMES])
		evaluateFermentV2Mock.mockClear()
		harness.sendMessage.mockClear()
		await settleFermentV2(harness, "continue")
		await vi.waitFor(() => expect(continuations(harness)).toHaveLength(1))

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await settleFermentV2(harness, "met")

		expect(evaluateFermentV2Mock).toHaveBeenCalledTimes(2)
		expect(harness.currentFermentV2()?.status).toBe("complete")
	})

	it("does not start when only part of the Todo toolset is visible", async () => {
		harness.setActiveTools([...FERMENT_V2_TOOL_NAMES, TODO_TOOL_NAMES[0]])
		await harness.command("keep going")

		expect(harness.sendMessage).not.toHaveBeenCalled()
		expect(harness.currentFermentV2()).toBeUndefined()
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 requires the Ferment V2 and Todo tools to be enabled before it can run.",
			"warning",
		)
	})

	it("pauses accounting when an agent turn is cancelled", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000)
		await harness.command("keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1_000 })
		dateNow.mockReturnValue(61_000)
		harness.sendMessage.mockClear()

		await harness.fire("turn_end", terminalTurn("aborted"))

		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", timeUsedMs: 60_000 })
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_aborted", status: "paused" }),
		)
		expect(harness.sendMessage).not.toHaveBeenCalled()
		dateNow.mockReturnValue(121_000)
		expect((await harness.tool(GET_FERMENT_V2_TOOL_NAME, {})).details.fermentV2).toMatchObject({ timeUsedMs: 60_000 })
	})

	it("continues after failures and pauses after three consecutive failures", async () => {
		await harness.command("keep going")
		harness.sendMessage.mockClear()
		evaluateFermentV2Mock.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			const failedTurn = terminalTurn("error")
			await harness.fire("turn_end", failedTurn)
			harness.appendEntry.mockClear()
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
			if (turnIndex < 3) expect(harness.currentFermentV2()?.status).toBe("active")
			expect(harness.appendEntry).toHaveBeenCalledTimes(1)
		}

		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		for (const [message] of harness.sendMessage.mock.calls) {
			expect(message.details).toMatchObject({ source: "agent_error", revision: 1 })
		}
		expect(harness.currentFermentV2()?.evaluationCount).toBeUndefined()
		expect(harness.currentFermentV2()?.status).toBe("paused")
		expect(harness.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_errors", status: "paused" }),
		)
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 3 consecutive agent errors.", "warning")
	})

	it("counts retry attempts once at the settled run boundary", async () => {
		await harness.command("keep going")
		harness.sendMessage.mockClear()
		harness.appendEntry.mockClear()

		for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn("error"))
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
		}

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.consecutiveErrorTurns).toBeUndefined()

		harness.appendEntry.mockClear()
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })
		expect(harness.appendEntry).toHaveBeenCalledTimes(1)
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.events.emit).not.toHaveBeenCalledWith(FERMENT_V2_EVENTS.PAUSED, expect.anything())
	})

	it("resolves a headless waiter when an agent-error continuation cannot be queued", async () => {
		const headless = createHarness({ hasUI: false })
		let resolved = false
		const command = headless.command("keep going").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())

		await headless.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await headless.fire("turn_end", terminalTurn("error"))
		await headless.fire("agent_end", { type: "agent_end", messages: [] })
		headless.sendMessage.mockImplementationOnce(() => {
			throw new Error("This extension ctx is stale: session torn down")
		})

		await headless.fire("agent_settled", { type: "agent_settled" })
		await command

		expect(resolved).toBe(true)
		expect(headless.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })
	})

	it("pauses after three consecutive agent-error turns split across a session restart", async () => {
		await harness.command("keep going")
		evaluateFermentV2Mock.mockClear()

		for (let turnIndex = 1; turnIndex <= 2; turnIndex++) {
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.fire("turn_end", terminalTurn("error"))
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
		}

		expect(harness.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 2 })
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()

		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })

		expect(resumed.currentFermentV2()?.status).toBe("paused")
		expect(resumed.events.emit).toHaveBeenLastCalledWith(
			FERMENT_V2_EVENTS.PAUSED,
			expect.objectContaining({ reason: "agent_errors", status: "paused" }),
		)
		expect(resumed.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 3 consecutive agent errors.", "warning")
	})

	it("still resets the stall-guard counters on an explicit /ferment-v2 resume", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("error"))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("stop"))
		await settleFermentV2(harness, "continue")
		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 1 })
		expect(harness.currentFermentV2()?.consecutiveErrorTurns).toBeUndefined()

		await harness.command("pause")
		await harness.command("resume")

		expect(harness.currentFermentV2()).toMatchObject({ status: "active" })
		expect(harness.currentFermentV2()?.consecutiveErrorTurns).toBeUndefined()
		expect(harness.currentFermentV2()?.unchangedContinuationTurns).toBeUndefined()

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: Date.now() })
		await settleFermentV2(harness, "continue")
		expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 2 })
	})

	it("persists a genuine progress reset across a session restart, not just increments", async () => {
		await harness.command("keep going")

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("error"))
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("stop"))
		await settleFermentV2(harness, "continue")
		expect(harness.currentFermentV2()?.consecutiveErrorTurns).toBeUndefined()

		const capturedBranch = [...harness.branch]
		const resumed = createHarness()
		resumed.setSession("session-a", capturedBranch)
		await resumed.fire("session_start", { type: "session_start", reason: "resume" })
		resumed.sendMessage.mockClear()

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 1 })

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 4, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentFermentV2()).toMatchObject({ status: "active", consecutiveErrorTurns: 2 })

		await resumed.fire("turn_start", { type: "turn_start", turnIndex: 5, timestamp: Date.now() })
		await resumed.fire("turn_end", terminalTurn("error"))
		await resumed.fire("agent_end", { type: "agent_end", messages: [] })
		await resumed.fire("agent_settled", { type: "agent_settled" })
		expect(resumed.currentFermentV2()?.status).toBe("paused")
	})

	it("stops continuation when the token budget is reached", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		harness.sendMessage.mockClear()

		const budgetTurn = terminalTurn("stop", { input: 80, output: 20 })
		await harness.fire("turn_end", budgetTurn)
		await harness.fire("agent_end", { type: "agent_end", messages: [budgetTurn.message] })
		harness.appendEntry.mockClear()
		evaluateFermentV2Mock.mockClear()
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(harness.currentFermentV2()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 stopped after reaching its 100 token budget.", "warning")
		expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("keeps a budget-limited headless command pending until the agent settles", async () => {
		const headless = createHarness({ hasUI: false })
		let resolved = false
		const command = headless.command("--tokens 100 keep going").then(() => {
			resolved = true
		})
		await vi.waitFor(() => expect(headless.sendMessage).toHaveBeenCalledOnce())

		await headless.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		const budgetTurn = terminalTurn("stop", { input: 80, output: 20 })
		await headless.fire("turn_end", budgetTurn)
		await Promise.resolve()

		expect(headless.currentFermentV2()?.status).toBe("budget_limited")
		expect(resolved).toBe(false)

		await headless.fire("agent_end", { type: "agent_end", messages: [budgetTurn.message] })
		expect(resolved).toBe(false)

		await headless.fire("agent_settled", { type: "agent_settled" })
		await command
		expect(resolved).toBe(true)
	})

	it("refuses to resume a Ferment V2 that is paused but still over its token budget", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("aborted", { input: 80, output: 20 }))
		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", tokenBudget: 100, tokensUsed: 100 })

		harness.sendMessage.mockClear()
		harness.ui.notify.mockClear()

		await harness.command("resume")

		expect(harness.currentFermentV2()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Ferment V2 token budget is exhausted. Start a replacement Ferment V2 with a new budget.",
			"warning",
		)
		expect(harness.ui.notify).not.toHaveBeenCalledWith("Ferment V2 resumed.", "info")
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("settles a headless resume instead of hanging when the Ferment V2 is paused but over budget", async () => {
		await harness.command("--tokens 100 keep going")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.fire("turn_end", terminalTurn("aborted", { input: 80, output: 20 }))
		expect(harness.currentFermentV2()).toMatchObject({ status: "paused", tokenBudget: 100, tokensUsed: 100 })

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

		expect(winner).not.toBe(TIMED_OUT)
		expect(resolved).toBe(true)
		expect(headless.currentFermentV2()).toMatchObject({ status: "budget_limited", tokenBudget: 100, tokensUsed: 100 })
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

		expect(harness.currentFermentV2()?.revision).toBe(2)
		for (const [message] of harness.sendMessage.mock.calls) {
			expect(message.details).toMatchObject({ revision: 2 })
		}
	})

	it("replays rewind and fork branches independently", async () => {
		await harness.command("revision one")
		const revision1Entry = harness.branch.at(-1)
		await harness.command("edit revision two")
		expect(harness.currentFermentV2()?.revision).toBe(2)

		harness.setBranch(revision1Entry ? [revision1Entry] : [])
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "b", newLeafId: "a" })
		expect(harness.currentFermentV2()).toMatchObject({ objective: "revision one", revision: 1 })

		harness.setSession("fork-session", revision1Entry ? [revision1Entry] : [])
		await harness.fire("session_start", { type: "session_start", reason: "fork" })
		await harness.command("edit fork objective")
		expect(harness.currentFermentV2()).toMatchObject({ objective: "fork objective", revision: 2 })
	})

	it("accepts settled todos restored after the current Ferment V2 revision", async () => {
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()
	})

	it("requires restored todos to be reconciled after editing the same Ferment V2", async () => {
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("settle every item") })
	})

	it("restores the latest Ferment V2 and settled todos across repeated compactions", async () => {
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

		expect(harness.currentFermentV2()).toMatchObject({ objective: "revision two", revision: 2 })
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
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
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
		const fermentV2Context = context.messages.find(
			(message) => message.role === "custom" && message.customType === FERMENT_V2_CONTEXT_MESSAGE_TYPE,
		)
		const fermentV2ContextText = JSON.stringify(fermentV2Context)

		expect(fermentV2ContextText).toContain("lessons")
		expect(fermentV2ContextText).toContain("decision")
		expect(fermentV2ContextText).toContain("reuse the native session journal")
		expect(fermentV2ContextText).not.toContain("Choose the persistence path")

		await harness.command("edit a replacement objective")
		await harness.fire("session_tree", { type: "session_tree", oldLeafId: "after", newLeafId: "edited" })
		const editedContext = (await harness.fire("context", {
			type: "context",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }],
		})) as { messages: ContextEvent["messages"] }

		expect(JSON.stringify(editedContext.messages)).toContain("reuse the native session journal")
	})

	it("keeps Ferment V2 instances and todo completion isolated while switching sessions", async () => {
		await harness.command("session A Ferment V2")
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
		await harness.command("session B Ferment V2")
		const sessionBBranch = [...harness.branch]

		harness.setSession("session-a", sessionABranch)
		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(harness.currentFermentV2()?.objective).toBe("session A Ferment V2")
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toBeUndefined()

		harness.setSession("session-b", sessionBBranch)
		await harness.fire("session_start", { type: "session_start", reason: "resume" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		expect(harness.currentFermentV2()?.objective).toBe("session B Ferment V2")
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolName: UPDATE_FERMENT_V2_TOOL_NAME,
				input: { status: "complete" },
			}),
		).toMatchObject({ block: true, reason: expect.stringContaining("visible tactical todo") })
	})

	describe("stale ctx handling", () => {
		it("treats a stale ctx from the busy check as not busy, skipping the pause steer", async () => {
			await harness.command("ship it")
			harness.sendMessage.mockClear()
			harness.setIdle(false)
			harness.setIdleError(new Error("This extension ctx is stale: session torn down"))

			await harness.command("pause")

			expect(harness.currentFermentV2()?.status).toBe("paused")
			expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused.", "info")
			expect(harness.sendMessage).not.toHaveBeenCalled()
		})

		it("treats a stale ctx from the pending-message check as blocked, skipping the resume kick", async () => {
			await harness.command("ship it")
			const capturedBranch = [...harness.branch]

			const resumed = createHarness()
			resumed.setSession("session-a", capturedBranch)
			resumed.setPendingMessagesError(new Error("This extension ctx is stale: session torn down"))

			await resumed.fire("session_start", { type: "session_start", reason: "resume" })

			expect(resumed.currentFermentV2()?.status).toBe("active")
			expect(resumed.sendMessage).not.toHaveBeenCalled()
		})

		it("treats a stale ctx as pending at the settled boundary", async () => {
			await harness.command("ship it")
			await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			harness.setPendingMessagesError(new Error("This extension ctx is stale: session torn down"))
			harness.sendMessage.mockClear()
			evaluateFermentV2Mock.mockClear()

			await harness.fire("agent_settled", { type: "agent_settled" })

			expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
			expect(harness.sendMessage).not.toHaveBeenCalled()
		})

		it("treats a stale ctx from sendMessage as an unsent steer, not a thrown error", async () => {
			await harness.command("ship it")
			harness.setIdle(false)
			await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
			harness.sendMessage.mockImplementationOnce(() => {
				throw new Error("This extension ctx is stale: session torn down")
			})

			await harness.command("pause")

			expect(harness.currentFermentV2()?.status).toBe("paused")
			expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused.", "info")
		})
	})

	describe("configurable policy settings", () => {
		it("pauses at the configured maxUnchangedContinuations count, not the default", async () => {
			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, maxUnchangedContinuations: 2 })
			await harness.command("keep going")
			harness.sendMessage.mockClear()

			await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
			await settleFermentV2(harness, "continue")
			expect(harness.currentFermentV2()).toMatchObject({ status: "active", unchangedContinuationTurns: 1 })

			await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
			await settleFermentV2(harness, "continue")

			expect(harness.currentFermentV2()?.status).toBe("paused")
			expect(harness.events.emit).toHaveBeenLastCalledWith(
				FERMENT_V2_EVENTS.STALLED,
				expect.objectContaining({ reason: "no_progress", continuationCount: 2, status: "paused" }),
			)
			expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 2 stalled continuation turns.", "warning")
		})

		it("pauses at the configured maxConsecutiveErrors count, not the default", async () => {
			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, maxConsecutiveErrors: 2 })
			await harness.command("keep going")
			harness.sendMessage.mockClear()
			evaluateFermentV2Mock.mockClear()

			for (let turnIndex = 1; turnIndex <= 2; turnIndex++) {
				await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
				await harness.fire("turn_end", terminalTurn("error"))
				harness.appendEntry.mockClear()
				await harness.fire("agent_end", { type: "agent_end", messages: [] })
				await harness.fire("agent_settled", { type: "agent_settled" })
				if (turnIndex < 2) expect(harness.currentFermentV2()?.status).toBe("active")
			}

			expect(evaluateFermentV2Mock).not.toHaveBeenCalled()
			expect(harness.currentFermentV2()?.status).toBe("paused")
			expect(harness.events.emit).toHaveBeenLastCalledWith(
				FERMENT_V2_EVENTS.PAUSED,
				expect.objectContaining({ reason: "agent_errors", status: "paused" }),
			)
			expect(harness.ui.notify).toHaveBeenCalledWith("Ferment V2 paused after 2 consecutive agent errors.", "warning")
		})

		it("does not schedule a resume continuation on session_start when autoResume is disabled", async () => {
			await harness.command("ship it")
			const capturedBranch = [...harness.branch]

			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, autoResume: false })
			const resumed = createHarness()
			resumed.setSession("session-a", capturedBranch)
			await resumed.fire("session_start", { type: "session_start", reason: "resume" })

			expect(resumed.currentFermentV2()?.status).toBe("active")
			expect(resumed.sendMessage).not.toHaveBeenCalled()
		})

		it("applies defaultTokenBudget to /ferment-v2 <objective> without --tokens", async () => {
			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("ship it")

			expect(harness.currentFermentV2()).toMatchObject({ tokenBudget: 500 })
		})

		it("lets an explicit --tokens win over a configured defaultTokenBudget", async () => {
			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("--tokens 250 ship it")

			expect(harness.currentFermentV2()).toMatchObject({ tokenBudget: 250 })
		})

		it("still lets an explicit --tokens win when replacing a Ferment V2 under a configured default", async () => {
			fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, defaultTokenBudget: 500 })

			await harness.command("first")
			expect(harness.currentFermentV2()).toMatchObject({ tokenBudget: 500 })

			await harness.command("--tokens 250 second")
			expect(harness.currentFermentV2()).toMatchObject({ objective: "second", tokenBudget: 250 })
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
	let activeTools: string[] = [...FERMENT_V2_TOOL_NAMES, ...TODO_TOOL_NAMES]

	let idleError: Error | undefined
	let pendingMessagesError: Error | undefined
	const ui = {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		editor: vi.fn(async (_title: string, value: string) => value),
		setStatus: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWidget: vi.fn(),
	}
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		branch.push(customEntry(customType, data))
	})
	const sendMessage = vi.fn()
	const abort = vi.fn()
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
		abort,
		waitForIdle,
		isIdle: () => {
			if (idleError) {
				const error = idleError
				idleError = undefined
				throw error
			}
			return idle
		},
		hasPendingMessages: () => {
			if (pendingMessagesError) {
				const error = pendingMessagesError
				pendingMessagesError = undefined
				throw error
			}
			return pending
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntries: () => branch,
		},
	} as unknown as ExtensionCommandContext

	fermentV2Extension(pi)

	return {
		pi,
		commands,
		tools,
		ui,
		appendEntry,
		sendMessage,
		abort,
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
		setPendingMessagesError(error: Error) {
			pendingMessagesError = error
		},
		setPending(value: boolean) {
			pending = value
		},
		setActiveTools(value: string[]) {
			activeTools = value
		},
		async fire(event: string, payload: unknown, eventSessionId = sessionId): Promise<unknown> {
			const eventContext =
				eventSessionId === sessionId
					? ctx
					: ({
							...ctx,
							sessionManager: { ...ctx.sessionManager, getSessionId: () => eventSessionId },
						} as ExtensionCommandContext)
			let result: unknown
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload as never, eventContext)
			}
			if (event === "session_start" || event === "agent_settled") {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			return result
		},
		async command(args: string): Promise<void> {
			await this.runCommand("ferment-v2", args)
		},
		async runCommand(name: string, args: string): Promise<void> {
			const command = commands.get(name)
			if (!command) throw new Error(`${name} command not registered`)
			await command.handler(args, ctx)
		},
		async tool(name: string, params: Record<string, unknown>) {
			const tool = tools.get(name)
			if (!tool) throw new Error(`${name} tool not registered`)
			return tool.execute("call-1", params, new AbortController().signal, () => undefined, ctx)
		},
		currentFermentV2(): SessionFermentV2 | undefined {
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index]
				if (entry.type !== "custom" || entry.customType !== FERMENT_V2_CUSTOM_ENTRY_TYPE) continue
				const journal = entry.data as FermentV2JournalEntry
				if (journal.op === "clear") return undefined
				if (journal.op === "put") return journal.fermentV2
			}
			return undefined
		},
		latestJournal(): FermentV2JournalEntry | undefined {
			const entry = branch.findLast(
				(candidate) => candidate.type === "custom" && candidate.customType === FERMENT_V2_CUSTOM_ENTRY_TYPE,
			)
			return entry?.type === "custom" ? (entry.data as FermentV2JournalEntry) : undefined
		},
	}
}

function continuations(harness: ReturnType<typeof createHarness>): Array<{ content: string }> {
	return harness.sendMessage.mock.calls
		.map((call) => call[0])
		.filter((message) => message?.customType === FERMENT_V2_CONTROL_MESSAGE_TYPE)
}

async function settleFermentV2(
	harness: ReturnType<typeof createHarness>,
	verdict: "continue" | "met" | "impossible" | "unavailable" = "continue",
	deliverAcceptedAnswer = true,
	reason?: string,
): Promise<void> {
	evaluateFermentV2Mock.mockResolvedValueOnce(
		verdict === "unavailable"
			? { verdict, reason: "No evaluator model is available." }
			: {
					verdict,
					reason: reason ?? (verdict === "met" ? "All requirements are evidenced." : "More work is required."),
					model: "test/evaluator",
					usage: EVALUATOR_USAGE,
				},
	)
	await harness.fire("agent_end", { type: "agent_end", messages: [] })
	await harness.fire("agent_settled", { type: "agent_settled" })
	if (
		verdict === "met" &&
		deliverAcceptedAnswer &&
		harness.sendMessage.mock.calls.some(([message]) => message?.details?.source === "evaluation_accepted")
	) {
		await finishFinalAnswerTurn(harness, "Delivered final answer.")
	}
}

async function finishFinalAnswerTurn(
	harness: ReturnType<typeof createHarness>,
	text: string,
	stopReason: "stop" | "error" | "aborted" = "stop",
	usage: { input?: number; output?: number } = { input: 0, output: 0 },
): Promise<void> {
	await harness.fire("turn_start", { type: "turn_start", turnIndex: 99, timestamp: Date.now() })
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		usage,
		timestamp: Date.now(),
	}
	await harness.fire("message_start", { type: "message_start", message })
	await harness.fire("message_end", { type: "message_end", message })
	await harness.fire("turn_end", { ...terminalTurn(stopReason, usage), message })
	await harness.fire("agent_end", { type: "agent_end", messages: [message] })
	await harness.fire("agent_settled", { type: "agent_settled" })
}

async function holdEvaluation(harness: ReturnType<typeof createHarness>): Promise<{
	release: (value: Awaited<ReturnType<typeof evaluateFermentV2>>) => void
	settled: Promise<unknown>
	signal: AbortSignal | undefined
}> {
	let release: (value: Awaited<ReturnType<typeof evaluateFermentV2>>) => void = () => undefined
	evaluateFermentV2Mock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve
			}),
	)
	await harness.fire("agent_end", { type: "agent_end", messages: [] })
	const settled = harness.fire("agent_settled", { type: "agent_settled" })
	await vi.waitFor(() => expect(evaluateFermentV2Mock).toHaveBeenCalled())
	const signal = evaluateFermentV2Mock.mock.calls.at(-1)?.[0].signal

	return { release, settled, signal }
}

async function completeVisibleTodo(harness: ReturnType<typeof createHarness>): Promise<void> {
	await modelTodoResult(harness, [{ id: 1, content: "Finish the Ferment V2", status: "completed" }])
}

async function modelTodoResult(harness: ReturnType<typeof createHarness>, todos: TodoItem[]): Promise<void> {
	await harness.fire("tool_execution_end", {
		type: "tool_execution_end",
		toolName: "update_todos",
		isError: false,
		result: {
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos,
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

function acceptedFinalControlContent(acceptedDraft: string): string {
	return `The objective is complete and ready for user delivery.

Give the user only the final answer to the original objective. If the original objective requires exact output, return exactly that output with no preface or summary. Otherwise, start with the outcome. Do not narrate the completion check, control messages, evidence gathering, or your internal process unless directly required by the original objective. Do not call tools.

Return this evaluated draft verbatim: ${JSON.stringify(acceptedDraft)}`
}

function messageEntry(message: Record<string, unknown>, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id: randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry
}

function customMessageEntry(
	customType: string,
	content: string,
	display: boolean | undefined,
	details: Record<string, unknown> | undefined,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom_message",
		id: randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		customType,
		content,
		...(display === undefined ? {} : { display }),
		...(details === undefined ? {} : { details }),
	} as unknown as SessionEntry
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

function requireFermentV2(fermentV2: SessionFermentV2 | undefined): SessionFermentV2 {
	if (!fermentV2) throw new Error("expected current Ferment V2")
	return fermentV2
}
