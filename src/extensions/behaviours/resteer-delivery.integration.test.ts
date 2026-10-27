/**
 * Delivery-guarantee integration test for behaviour re-steer after compaction.
 *
 * Modeled on `prompt-construction/anthropic-prefix-cache.test.ts`: the REAL
 * behaviours wiring (`wireBehaviours`) runs over a simulated growing session,
 * and the next model request is captured through the real anthropic-messages
 * serializer behind a stub fetch. A mocked `sendMessage` proves only that a
 * call was made — here the assertion is on the actual request payload, so the
 * test proves the guidance reaches the model.
 *
 * The scenario under test: a tool-triggered behaviour loads mid-turn and its
 * body is steered; compaction rewrites the context (dropping the steer) and
 * fires `session_compact` with no user prompt in between. The re-steer must
 * land in the next model request — for inline overflow recovery
 * (`willRetry: true`, the retried turn) and for a manual compaction between
 * turns alike, for default (steer + re-steer) and `standing` behaviours.
 */
import type { Message, Model } from "@earendil-works/pi-ai"
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages"
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { convertToLlm } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	type RenderedSystemPromptBlock,
	renderSystemPromptBlocks,
} from "../prompt-construction/system-prompt-blocks.js"
import { SYSTEM_REMINDER_OPEN } from "../steer-marker.js"
import type { ResolverIO } from "./session-context.js"
import { tool } from "./triggers.js"
import type { Behaviour } from "./types.js"
import { wireBehaviours } from "./wiring.js"

const SESSION_ID = "resteer-delivery-session"

/** Session-pipeline message shape — the same element type the `context`
 *  event carries (pi-coding-agent does not re-export `AgentMessage` from
 *  its package root). */
type AgentMessage = ContextEvent["messages"][number]

const HABIT_BODY = "HABIT-BODY: run ast.parse on any .py file before claiming it works."
const POLICY_BODY = "POLICY-BODY: never run an external write command without explicit consent."

/** Default delivery class (no `standing`): steer + re-steer, block never renders. */
const habitNudge: Behaviour = {
	kind: "triggered",
	name: "habit-nudge",
	description: "habit guidance",
	body: HABIT_BODY,
	triggers: { tool: tool("edit", (i) => i.path.endsWith(".py")) },
}

/** `standing: true`: block renders on every load path; tool loads re-steer too. */
const standingPolicy: Behaviour = {
	kind: "triggered",
	name: "standing-policy",
	description: "consent policy",
	body: POLICY_BODY,
	triggers: { tool: tool("bash", (i) => i.command.startsWith("gh ")) },
	standing: true,
}

const stubIO: ResolverIO = {
	hasCli: () => false,
	readGitRemoteHost: () => undefined,
	isGitRepo: () => false,
	walkPaths: () => new Set<string>(),
	detectLspExtensions: () => new Set<string>(),
}

// ─── Session fixture ─────────────────────────────────────────────────────────

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as unknown as AgentMessage
}

function assistantToolCall(
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
	timestamp: number,
): AgentMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	} as unknown as AgentMessage
}

function toolResult(callId: string, toolName: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		timestamp,
	} as unknown as AgentMessage
}

/** A manual/overflow compaction rewrites the context: every prior message —
 *  including steered bodies — is replaced by the summary. This is the rewrite
 *  the re-steer exists to survive. */
function compactHistory(history: AgentMessage[], timestamp: number): void {
	history.splice(0, history.length, {
		role: "compactionSummary",
		summary: "Earlier work summarized.",
		timestamp,
	} as unknown as AgentMessage)
}

// ─── Harness: real wiring over a simulated growing session ───────────────────

interface ResteerHarness {
	history: AgentMessage[]
	/** The shared ExtensionAPI mock — inspect sendMessage calls via `.sendMessage.mock.calls`. */
	mock: ReturnType<typeof createExtensionApi>
	fire(event: string, payload: unknown): Promise<unknown>
}

const activeHarnesses: ResteerHarness[] = []

function createHarness(behaviours: readonly Behaviour[]): ResteerHarness {
	const mock = createExtensionApi()
	/** Simulated persistent session history. pi.sendMessage persists here,
	 *  mirroring what the session manager does with steer (custom) messages. */
	const history: AgentMessage[] = []
	let ts = 1000

	mock.sendMessage.mockImplementation((message) => {
		history.push({
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: ts++,
		} as unknown as AgentMessage)
	})

	const ctx = createContext({
		hasUI: false,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => history as unknown as SessionEntry[],
		},
	})

	wireBehaviours(mock.api, behaviours, { resolverIO: stubIO })

	async function fire(event: string, payload: unknown): Promise<unknown> {
		const results = await mock.emit(event, payload, ctx)
		return results.at(-1)
	}

	const harness = { history, mock, fire }
	activeHarnesses.push(harness)
	return harness
}

afterEach(async () => {
	// Clears the module-global system-prompt-block handle state keyed by pi.
	for (const h of activeHarnesses.splice(0)) {
		await h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" })
	}
})

/** Drive the shared load sequence: both behaviours load via tool calls in one
 *  turn and their bodies are steered as each tool result arrives. */
async function driveToolLoads(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.fire("session_start", { type: "session_start", reason: "new" })
	await h.fire("turn_start", { turnIndex: 1 })
	// Load #1: habit-nudge via a .py edit.
	h.history.push(assistantToolCall("call-1", "edit", { path: "parser.py" }, 1000))
	await h.fire("tool_call", { toolName: "edit", input: { path: "parser.py", oldText: "a", newText: "b" } })
	h.history.push(toolResult("call-1", "edit", "ok", 1001))
	await h.fire("tool_result", { toolName: "edit", input: { path: "parser.py" } })
	// Load #2: standing-policy via a gh bash invocation.
	h.history.push(assistantToolCall("call-2", "bash", { command: "gh pr list" }, 1002))
	await h.fire("tool_call", { toolName: "bash", input: { command: "gh pr list" } })
	h.history.push(toolResult("call-2", "bash", "ok", 1003))
	await h.fire("tool_result", { toolName: "bash", input: { command: "gh pr list" } })
}

// ─── Real anthropic-messages wire capture ─────────────────────────────────────

const model = {
	id: "claude-sonnet-5",
	name: "claude-sonnet-5",
	api: "anthropic-messages",
	provider: "kimchi-dev/anthropic",
	baseUrl: "http://localhost:9", // intercepted by the capture fetch below
	maxTokens: 128000,
	input: ["text"],
	output: ["text"],
	reasoning: false,
} as unknown as Model<"anthropic-messages">

const TEST_TOOLS = [
	{
		name: "bash",
		description: "run bash",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "edit",
		description: "edit file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
]

interface CapturedBody {
	system: unknown
	tools: unknown
	messages: Array<Record<string, unknown>>
}

async function captureRequestBody(messages: AgentMessage[]): Promise<CapturedBody> {
	let capturedBody: string | undefined
	const captureFetch = async (_url: unknown, init: unknown) => {
		capturedBody = String((init as { body?: unknown })?.body ?? "")
		return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "captured" } }), {
			status: 500,
			headers: { "content-type": "application/json" },
		})
	}
	try {
		const s = stream(
			model,
			{
				systemPrompt: "You are a resteer delivery test.",
				tools: TEST_TOOLS,
				messages: convertToLlm(messages) as Message[],
			},
			{ apiKey: "replay-key", fetch: captureFetch as unknown as typeof fetch },
		)
		for await (const ev of s) {
			if (ev?.type === "error") break
		}
	} catch {
		// The stub fetch always fails after the body was captured — expected.
	}
	expect(capturedBody, "request body was captured").toBeTruthy()
	return JSON.parse(capturedBody as string) as CapturedBody
}

function messagesContaining(body: CapturedBody, text: string): Array<Record<string, unknown>> {
	return body.messages.filter((m) => JSON.stringify(m).includes(text))
}

/** The text of the first text-content block of a converted request message. */
function firstText(message: Record<string, unknown>): string {
	const content = message.content as Array<{ type?: string; text?: string }> | undefined
	return content?.find((c) => typeof c.text === "string")?.text ?? ""
}

function blocksText(blocks: RenderedSystemPromptBlock[]): string {
	return blocks.map((b) => b.content).join("\n")
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("behaviour resteer delivery (request-level)", () => {
	it("delivers the first tool-triggered steer in the same turn's request; the habit block never renders", async () => {
		const h = createHarness([habitNudge, standingPolicy])
		await driveToolLoads(h)

		const body = await captureRequestBody([...h.history])

		// Both bodies reached the model as marked user-role steer messages.
		const habit = messagesContaining(body, HABIT_BODY)
		expect(habit).toHaveLength(1)
		expect(habit[0].role).toBe("user")
		expect(firstText(habit[0])).toContain(SYSTEM_REMINDER_OPEN)
		const policy = messagesContaining(body, POLICY_BODY)
		expect(policy).toHaveLength(1)
		expect(policy[0].role).toBe("user")

		// Block render: the habit body must never appear in the system prompt
		// (that late-render block is the cache invalidation this design removes);
		// the standing body does render its block on a tool load.
		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "orchestrator" })
		expect(blocksText(blocks)).not.toContain(HABIT_BODY)
		expect(blocksText(blocks)).toContain(POLICY_BODY)
	})

	it("re-steers into the retried turn's request after an inline overflow compaction (willRetry: true, no user prompt)", async () => {
		const h = createHarness([habitNudge, standingPolicy])
		await driveToolLoads(h)

		// Inline overflow compaction mid-turn: the context is rewritten (the
		// just-steered bodies are consumed by the aborted turn) and the turn is
		// retried. No user prompt is appended before the next model request.
		compactHistory(h.history, 1004)
		await h.fire("session_compact", { type: "session_compact", reason: "overflow", willRetry: true })

		const body = await captureRequestBody([...h.history])
		expect(body.messages[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: expect.arrayContaining([expect.objectContaining({ type: "text" })]),
			}),
		)

		// THE delivery guarantee: both bodies are present in the retried
		// turn's request payload despite the rewrite — default and standing
		// behaviours alike.
		expect(messagesContaining(body, HABIT_BODY)).toHaveLength(1)
		expect(messagesContaining(body, POLICY_BODY)).toHaveLength(1)
		const habitMsg = messagesContaining(body, HABIT_BODY)[0]
		expect(firstText(habitMsg)).toContain(SYSTEM_REMINDER_OPEN)
	})

	it("re-steers into the next request after a manual compaction between turns (willRetry: false)", async () => {
		const h = createHarness([habitNudge, standingPolicy])
		await driveToolLoads(h)

		// Next user prompt, then a manual /compact: context rewritten, steer
		// dropped, re-steer appended before the next model request.
		h.history.push(userMessage("continue", 1004))
		compactHistory(h.history, 1005)
		await h.fire("session_compact", { type: "session_compact", reason: "manual", willRetry: false })

		const body = await captureRequestBody([...h.history])
		expect(messagesContaining(body, HABIT_BODY)).toHaveLength(1)
		expect(messagesContaining(body, POLICY_BODY)).toHaveLength(1)

		// Block render across the compaction boundary is unchanged: the habit
		// body still never renders a block (cache-stable prompt), the standing
		// block still renders its policy body.
		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "orchestrator" })
		expect(blocksText(blocks)).not.toContain(HABIT_BODY)
		expect(blocksText(blocks)).toContain(POLICY_BODY)
	})

	it("re-steers on every compaction event and standing blocks stay rendered after the rewrite", async () => {
		const h = createHarness([habitNudge, standingPolicy])
		await driveToolLoads(h)

		compactHistory(h.history, 1004)
		await h.fire("session_compact", { type: "session_compact", reason: "threshold", willRetry: false })
		await h.fire("session_compact", { type: "session_compact", reason: "manual", willRetry: false })

		const body = await captureRequestBody([...h.history])
		// Two compactions → two re-steers per behaviour, no once-only gating.
		expect(messagesContaining(body, HABIT_BODY)).toHaveLength(2)
		expect(messagesContaining(body, POLICY_BODY)).toHaveLength(2)

		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "orchestrator" })
		expect(blocksText(blocks)).toContain(POLICY_BODY)
		expect(blocksText(blocks)).not.toContain(HABIT_BODY)
	})
})
