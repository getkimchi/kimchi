import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as config from "../../config.js"
import * as startupContext from "../../startup-context.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import { ASSISTANT_OUTPUT_WITHHELD } from "../orchestration/continuation-nudge.js"
import promptEnrichmentExtension from "../prompt-construction/prompt-enrichment.js"
import { latestFinalAnswerDraftEntry } from "./final-answer.js"

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "kimi-k2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

/** Same conditional-spread marking pattern as exploration-guard.test.ts —
 *  no cast, and the result stays assignable to AssistantMessage. */
function assistant(content: AssistantMessage["content"], withheld = false): AssistantMessage {
	return {
		...makeAssistant(content),
		...(withheld ? { [ASSISTANT_OUTPUT_WITHHELD]: true } : {}),
	}
}

/**
 * The orchestrator's recovery marking (prompt-enrichment message_end) reuses
 * ASSISTANT_OUTPUT_WITHHELD, so ferment's final-answer reader can encounter
 * marked protocol messages on the same session branch it scans at agent_end.
 * These tests pin the direct reader contract: withheld output is invisible to
 * the draft reader, and protocol responses never become completion
 * candidates. The integration describe below proves the same contract holds
 * for marks produced by the real replacement and read back through a real
 * session branch.
 */
describe("latestFinalAnswerDraftEntry × withheld recovery marking", () => {
	it("treats a marked blank recovery message as supplying no draft", () => {
		const marked = assistant([], true)

		// A blanked <done> acknowledgement carries no text: the reader skips
		// it entirely rather than returning an empty draft.
		expect(latestFinalAnswerDraftEntry([marked])).toBeUndefined()
	})

	it("classifies retained withheld text as invisible", () => {
		// Ferment's own withholding can retain text on the marked message
		// (it filters tool calls, not always text). The visible flag must be
		// false so already-delivered detection does not treat it as shown.
		const markedWithText = assistant([{ type: "text", text: "Held-back final answer." }], true)

		const entry = latestFinalAnswerDraftEntry([markedWithText])
		expect(entry?.draft).toBe("Held-back final answer.")
		expect(entry?.visible).toBe(false)
	})

	it("keeps an ordinary visible final answer visible across a later marked message", () => {
		const visible = assistant([{ type: "text", text: "The comparison is complete." }])
		const markedBlank = assistant([], true)

		// The protocol output (blanked <done> after the answer) must not
		// become a completion candidate: the reader scans back past it to
		// the visible answer.
		const entry = latestFinalAnswerDraftEntry([visible, markedBlank])
		expect(entry?.draft).toBe("The comparison is complete.")
		expect(entry?.visible).toBe(true)
	})

	it("skips tool-bearing messages, marked or not", () => {
		const markedToolBearing = assistant(
			[
				{ type: "text", text: "Working." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
			true,
		)

		expect(latestFinalAnswerDraftEntry([markedToolBearing])).toBeUndefined()
	})
})

/**
 * Integration: the marker ferment's reader reacts to is the one the
 * orchestrator's real `message_end` handler produces. A recovery response is
 * streamed through the real extension (message_update blanking + message_end
 * replacement, applied in place exactly as agent-session does), persisted to
 * a real SessionManager branch, and read back the way ferment's agent_end
 * handler reads it: `buildSessionContext(sessionManager.getBranch())` →
 * `latestFinalAnswerDraftEntry`.
 */
describe("latestFinalAnswerDraftEntry × real recovery marking on a session branch", () => {
	let sessionDir: string

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "kimchi-final-answer-branch-"))
		vi.restoreAllMocks()
		vi.spyOn(agentWorkerContext, "isAgentWorker").mockReturnValue(false)
		vi.spyOn(startupContext, "getAvailableModels").mockReturnValue([])
		vi.spyOn(config, "loadConfig").mockReturnValue({
			apiKey: "",
			agentConfigDir: "",
		} as ReturnType<typeof config.loadConfig>)
	})

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true })
	})

	/** Mirrors agent-session's `_replaceMessageInPlace` for message_end
	 *  results — the stored message IS the replacement. */
	function applyInPlace(message: AssistantMessage, result: unknown): void {
		const replacement = (result as { message?: unknown } | undefined)?.message
		if (replacement == null || typeof replacement !== "object") return
		const record = message as unknown as Record<string, unknown>
		for (const key of Object.keys(record)) delete record[key]
		Object.assign(record, replacement)
	}

	it("a marked recovery acknowledgement on the branch supplies no draft; the visible answer wins", async () => {
		const shared = createExtensionApi()
		promptEnrichmentExtension(() => [])(shared.api)
		const ctx = createContext({ model: { provider: "test", id: "test-model" } })
		const fire = async (event: string, payload: unknown) => {
			let result: unknown
			for (const handler of shared.getHandlers(event)) {
				result = await handler(payload, ctx)
			}
			return result
		}
		const sessionManager = SessionManager.create(sessionDir, sessionDir)

		// The conversation the branch will carry, in the trace's shape: a
		// user question, then the visible text-only answer whose turn_end arms
		// the nudge (the answer IS the drift turn — one message, not two).
		sessionManager.appendMessage({ role: "user", content: "summarize the comparison", timestamp: 1 })
		const answer = makeAssistant([{ type: "text", text: "The comparison is complete." }])
		await fire("tool_execution_start", {})
		await fire("input", { source: "user" })
		sessionManager.appendMessage(answer)
		await fire("turn_end", { message: answer })
		expect(shared.sendMessage.mock.calls).toHaveLength(1)

		// The recovery response streams through the real handlers: deltas
		// blanked by message_update, the replacement produced by message_end
		// and applied in place — the message persisted to the branch is the
		// blanked, marked one, exactly as agent-session persists it.
		const first = makeAssistant([{ type: "text", text: "<do" }])
		await fire("message_update", {
			message: first,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "<do", partial: first },
		})
		const second = makeAssistant([{ type: "text", text: "ne>" }])
		await fire("message_update", {
			message: second,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ne>", partial: second },
		})
		const result = await fire("message_end", { message: second })
		expect(result).toBeDefined()
		applyInPlace(second, result)
		expect((second as unknown as Record<symbol, unknown>)[ASSISTANT_OUTPUT_WITHHELD]).toBe(true)
		sessionManager.appendMessage(second)
		await fire("turn_end", { message: second })
		expect(shared.sendMessage.mock.calls).toHaveLength(1)

		// Ferment's read path: the branch (in-memory entries keep the live
		// message objects, so the symbol survives) → context → draft reader.
		const messages = [...buildSessionContext(sessionManager.getBranch()).messages]
		const entry = latestFinalAnswerDraftEntry(messages)

		// The marked blank acknowledgement supplies no draft and is never a
		// visible completion candidate; the reader scans back to the visible
		// answer, which stays visible.
		expect(entry?.draft).toBe("The comparison is complete.")
		expect(entry?.visible).toBe(true)
	})
})
