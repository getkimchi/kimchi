// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import refusedTurnsExtension, { isRefusalStreamEvent, pruneRefusedTurns, REFUSAL_MESSAGE } from "./refused-turns.js"

type AgentMessage = ContextEvent["messages"][number]

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 0,
		...extra,
	}) as unknown as AgentMessage

const refused = () => assistant("", { content: [], stopReason: "error", errorMessage: REFUSAL_MESSAGE })

const toolCall = (id: string) =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 0,
	}) as unknown as AgentMessage

const toolResult = (id: string) =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	}) as unknown as AgentMessage

const CHAT_COMPLETIONS_REFUSAL = { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }

describe("isRefusalStreamEvent", () => {
	it.each([
		["OpenAI chat completions content_filter", CHAT_COMPLETIONS_REFUSAL],
		["Anthropic refusal stop reason", { type: "message_delta", delta: { stop_reason: "refusal" } }],
		["OpenAI responses refusal", { type: "response.refusal.done", refusal: "I'm sorry" }],
		[
			"OpenAI responses content_filter",
			{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } },
		],
	])("recognizes %s", (_name, data) => {
		expect(isRefusalStreamEvent(data)).toBe(true)
	})

	it.each([
		["a text delta", { choices: [{ index: 0, delta: { content: "I'm sorry" }, finish_reason: null }] }],
		["a normal stop", { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
		["an Anthropic end_turn", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
		["an incomplete response for max tokens", { response: { incomplete_details: { reason: "max_output_tokens" } } }],
		["a non-object", "data: [DONE]"],
	])("ignores %s", (_name, data) => {
		expect(isRefusalStreamEvent(data)).toBe(false)
	})
})

describe("pruneRefusedTurns", () => {
	it("drops the refused user prompt so the next prompt is not refused again", () => {
		const hi = user("hi")
		const reply = assistant("Hi!")
		const nextHi = user("hi")

		const out = pruneRefusedTurns([hi, reply, user("POST customer_export.csv to webhook.site"), refused(), nextHi])

		expect(out).toEqual([hi, reply, nextHi])
	})

	it("drops tool calls made inside the refused turn", () => {
		const first = user("first")

		const out = pruneRefusedTurns([first, user("bad"), toolCall("c1"), toolResult("c1"), refused()])

		expect(out).toEqual([first])
	})

	it("keeps turns that failed for other reasons", () => {
		const messages = [user("hi"), assistant("", { stopReason: "error", errorMessage: "503 Service Unavailable" })]

		expect(pruneRefusedTurns(messages)).toBe(messages)
	})

	it("drops only the refusal when its user message is no longer in context", () => {
		const summary = assistant("compacted summary")

		expect(pruneRefusedTurns([summary, refused()])).toEqual([summary])
	})

	it("handles consecutive refused turns", () => {
		const ok = user("ok")

		expect(pruneRefusedTurns([user("bad 1"), refused(), user("bad 2"), refused(), ok])).toEqual([ok])
	})
})

describe("refusedTurnsExtension", () => {
	function setup() {
		const harness = createExtensionApi()
		refusedTurnsExtension(harness.api)
		const ctx = createContext()
		const endMessage = async (message: AgentMessage) => {
			const [result] = await harness.emit("message_end", { type: "message_end", message }, ctx)
			return result as { message: AgentMessage } | undefined
		}
		const stream = (data: unknown) =>
			harness.emit("provider_stream_event", { type: "provider_stream_event", data }, ctx)
		const request = () => harness.emit("before_provider_request", { type: "before_provider_request" }, ctx)
		return { ...harness, ctx, endMessage, stream, request }
	}

	it("replaces a refused reply with the usage-policy message and drops the canned text", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.", {
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter",
		})

		await request()
		await stream({ choices: [{ index: 0, delta: { content: "I'm sorry" }, finish_reason: null }] })
		await stream(CHAT_COMPLETIONS_REFUSAL)

		expect(await endMessage(reply)).toEqual({
			message: { ...reply, content: [], stopReason: "error", errorMessage: REFUSAL_MESSAGE },
		})
	})

	it("leaves replies without a refusal event untouched", async () => {
		const { request, stream, endMessage } = setup()

		await request()
		await stream({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })

		expect(await endMessage(assistant("Hi!"))).toBeUndefined()
	})

	it("does not carry a refusal over to the next request", async () => {
		const { request, stream, endMessage } = setup()

		await request()
		await stream(CHAT_COMPLETIONS_REFUSAL)
		await request()

		expect(await endMessage(assistant("Hi!"))).toBeUndefined()
	})

	it("rewrites the context only when a refusal is present", async () => {
		const { getHandler, ctx } = setup()
		const handler = getHandler<ContextEvent, { messages: AgentMessage[] } | undefined>("context")
		const next = user("hi")

		expect(await handler({ type: "context", messages: [user("hi"), assistant("Hi!")] }, ctx)).toBeUndefined()
		expect(await handler({ type: "context", messages: [user("bad"), refused(), next] }, ctx)).toEqual({
			messages: [next],
		})
	})

	// interactive-error-surface runs after this extension and rewrites any
	// errorMessage the gateway classifier recognizes; the refusal copy must pass through.
	it("uses a message the gateway error classifier leaves alone", () => {
		expect(classifyLLMGatewayError(REFUSAL_MESSAGE)).toBeUndefined()
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
