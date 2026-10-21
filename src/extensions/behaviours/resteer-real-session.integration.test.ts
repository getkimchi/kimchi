/**
 * Real-session delivery guarantee for behaviour re-steer after compaction.
 *
 * The simulated-harness test (`resteer-delivery.integration.test.ts`) fires
 * `session_compact` synthetically; this test drives the REAL pi SDK lifecycle
 * instead — a real `AgentSession` over a stubbed provider, with the real
 * behaviours wiring registered as an extension factory:
 *
 *   1. the model calls a custom tool → the tool result triggers both
 *      behaviour loads → the wiring steers both bodies (first delivery);
 *   2. a second tool round produces a large tool result, and the next
 *      scripted response is a context-overflow error — the REAL overflow
 *      detector (`isContextOverflow`) classifies it, the session removes the
 *      failed message and compacts with `willRetry: true`;
 *   3. the compaction summarization call goes through the same stub, the
 *      real `session_compact` event fires, and the wiring re-steers;
 *   4. the turn is retried on the rewritten context.
 *
 * Assertions prove delivery through the real lifecycle:
 *   - the session branch contains the persisted re-steer entries
 *     (`custom_message` / customType "behaviour", details.reason "compaction")
 *     positioned after the compaction entry — decisive evidence the handler
 *     ran inside the real compaction event;
 *   - the retried model request (captured at the streamSimple boundary, built
 *     around the compaction summary) carries both behaviour bodies again.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { afterEach, describe, expect, it } from "vitest"
import { tool } from "./triggers.js"
import type { Behaviour } from "./types.js"
import { wireBehaviours } from "./wiring.js"

const HABIT_BODY = "REAL-HABIT-BODY: run ast.parse on any .py file before claiming it works."
const POLICY_BODY = "REAL-POLICY-BODY: never run an external write command without explicit consent."

/** Default delivery class (no `standing`): steer + re-steer, block never renders. */
const habitNudge: Behaviour = {
	kind: "triggered",
	name: "real-habit-nudge",
	description: "habit guidance",
	body: HABIT_BODY,
	triggers: { tool: tool("dump", () => true) },
}

/** `standing: true`: block renders on every load path; tool loads re-steer too. */
const standingPolicy: Behaviour = {
	kind: "triggered",
	name: "real-standing-policy",
	description: "consent policy",
	body: POLICY_BODY,
	triggers: { tool: tool("dump", () => true) },
	standing: true,
}

const SUMMARY_MARKER = "REAL-SESSION-SUMMARY: earlier work summarized."
const OVERFLOW_ERROR = "Your input exceeds the context window of this model"
/** Large tool result (~50k estimated tokens) — pushes the first steers outside
 *  the compaction keep-recent window so the retried request can only contain
 *  the bodies via the re-steer, not via retained originals. */
const BULK_RESULT = `B ${"bulk ".repeat(40_000)}`

const model: Model<Api> = {
	id: "resteer-stub-model",
	name: "Resteer Stub",
	api: "openai-completions",
	provider: "resteer-stub",
	baseUrl: "http://resteer-stub.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

function baseMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

/** Emit a full AssistantMessageEventStream for a plain text response. */
function textStream(
	text: string,
	stopReason: "stop" | "length" = "stop",
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream()
	const partial = baseMessage("")
	stream.push({ type: "start", partial })
	stream.push({ type: "text_start", contentIndex: 0, partial })
	const filled = { ...partial, content: [{ type: "text", text }] } as AssistantMessage
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: filled })
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: filled })
	const final = { ...filled, stopReason }
	stream.push({ type: "done", reason: stopReason, message: final })
	return stream
}

function toolCallStream(callId: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream()
	const partial = baseMessage("")
	stream.push({ type: "start", partial })
	const toolCall = { type: "toolCall" as const, id: callId, name: "dump", arguments: {} }
	const withCall = { ...partial, content: [toolCall] } as AssistantMessage
	stream.push({ type: "toolcall_start", contentIndex: 0, partial })
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: withCall })
	const final = { ...withCall, stopReason: "toolUse" } as AssistantMessage
	stream.push({ type: "done", reason: "toolUse", message: final })
	return stream
}

function errorStream(errorMessage: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream()
	const partial = baseMessage("")
	stream.push({ type: "start", partial })
	const failed = { ...partial, stopReason: "error", errorMessage } as AssistantMessage
	stream.push({ type: "error", reason: "error", error: failed })
	return stream
}

function messageText(m: unknown): string {
	const record = m as { content?: unknown; systemPrompt?: unknown }
	if (typeof record.content === "string") return record.content
	if (Array.isArray(record.content)) {
		return record.content
			.map((c) =>
				typeof c === "object" && c !== null && "text" in (c as Record<string, unknown>)
					? String((c as { text: unknown }).text)
					: "",
			)
			.join("\n")
	}
	return ""
}

describe("behaviour resteer through a real AgentSession (overflow recovery)", () => {
	const tmpDirs: string[] = []
	let cleanup: (() => Promise<void>) | undefined

	afterEach(async () => {
		if (cleanup) await cleanup()
		cleanup = undefined
	})

	it("re-steers both bodies into the retried request after a real overflow compaction", {
		timeout: 60_000,
	}, async () => {
		const tmp = mkdtempSync(join(tmpdir(), "resteer-real-session-"))
		tmpDirs.push(tmp)

		/** Every provider request, in order — each entry is the AgentMessage
		 *  context the session was about to convert and send. */
		const requests: Context[] = []
		const streamSimple = (_m: Model<Api>, context: Context) => {
			requests.push(context)
			// The compaction summarizer serializes the whole conversation into a
			// single user message wrapped in <conversation> tags.
			const isSummarizer = messageText(context.messages[0]).startsWith("<conversation>")
			const text = () => context.messages.map(messageText).join("\n")
			const toolResultCount = context.messages.filter((msg) => (msg as { role?: string }).role === "toolResult").length
			if (isSummarizer) {
				// Compaction summarization call — plain text, no tools.
				return textStream(SUMMARY_MARKER)
			}
			if (text().includes(SUMMARY_MARKER)) {
				// Post-compaction retried turn: final answer.
				return textStream("RESTEER-REAL-FINAL: done after compaction.")
			}
			if (toolResultCount === 0) {
				return toolCallStream("call-dump-1")
			}
			if (toolResultCount === 1) {
				return toolCallStream("call-dump-2")
			}
			// Two tool results in, no compaction summary yet: overflow error.
			return errorStream(OVERFLOW_ERROR)
		}

		const modelRuntime = await ModelRuntime.create({ authPath: join(tmp, "auth.json"), modelsPath: null })
		modelRuntime.registerProvider("resteer-stub", {
			name: "Resteer Stub",
			baseUrl: model.baseUrl,
			apiKey: "stub",
			api: "openai-completions",
			streamSimple,
		})

		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "You are a resteer real-session test.",
			appendSystemPromptOverride: () => [],
			extensionFactories: [(pi) => wireBehaviours(pi, [habitNudge, standingPolicy])],
		})
		await loader.reload()

		const dumpTool = {
			name: "dump",
			label: "Dump",
			description: "Returns bulk text.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: BULK_RESULT }], details: undefined }),
		}

		const { session } = await createAgentSession({
			cwd: tmp,
			agentDir: tmp,
			sessionManager: SessionManager.inMemory(tmp),
			settingsManager: SettingsManager.create(tmp, tmp),
			model,
			modelRuntime,
			resourceLoader: loader,
			customTools: [dumpTool],
		})
		await session.bindExtensions({
			onError: (err) => {
				throw new Error(`behaviours extension failed to bind: ${err.error ?? err.extensionPath}`)
			},
		})
		cleanup = async () => {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
			for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
		}

		await session.prompt("dump some bulk text twice, then finish")

		// The scenario must actually have run: initial turn, two tool rounds,
		// an overflow-failing response, at least one summarization call, and
		// the retried turn built around the compaction summary.
		const requestTexts = requests.map((r) => r.messages.map(messageText).join("\n"))
		expect(
			requestTexts.some((t) => t.includes(OVERFLOW_ERROR) || t.includes(BULK_RESULT)),
			"bulk round happened",
		).toBe(true)
		const retriedIdx = requestTexts.findIndex((t) => t.includes(SUMMARY_MARKER))
		expect(retriedIdx, "a post-compaction (retried) request exists").toBeGreaterThan(-1)

		// THE delivery guarantee: the retried request — built from the rewritten
		// context — carries both behaviour bodies again, delivered as marked
		// steers. The bulk tool result pushed the first steers out of the
		// keep-recent window, so these can only be the re-steers.
		const retried = requestTexts[retriedIdx]
		expect(retried).toContain(HABIT_BODY)
		expect(retried).toContain(POLICY_BODY)
		expect(retried).toContain("<system-reminder>")

		// Session-log evidence through the real extension runner: persisted
		// re-steer entries positioned after the compaction entry.
		const branch = session.sessionManager.getBranch()
		const compactionIdx = branch.findLastIndex((e) => e.type === "compaction")
		expect(compactionIdx, "session was compacted").toBeGreaterThan(-1)
		// Custom (steer) messages persist as `custom_message` entries carrying the
		// behaviour customType and the delivery details.
		const entryDetails = (e: unknown) => JSON.stringify((e as { details?: unknown }).details ?? {})
		const isBehaviourEntry = (e: unknown) =>
			(e as { type?: string; customType?: string }).type === "custom_message" &&
			(e as { customType?: string }).customType === "behaviour"
		const resteerIdx = branch.findIndex(
			(e, i) => i > compactionIdx && isBehaviourEntry(e) && entryDetails(e).includes("compaction"),
		)
		expect(resteerIdx, "re-steer entry persisted after the compaction entry").toBeGreaterThan(-1)
		const firstSteerIdx = branch.findIndex((e) => isBehaviourEntry(e) && !entryDetails(e).includes("compaction"))
		expect(firstSteerIdx, "first delivery entry persisted before the compaction").toBeGreaterThan(-1)
		expect(firstSteerIdx).toBeLessThan(compactionIdx)
	})
})
