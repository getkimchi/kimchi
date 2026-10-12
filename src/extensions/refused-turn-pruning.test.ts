import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { preserveRawErrorMessage } from "./error-preservation.js"
import refusedTurnPruningExtension, { pruneRefusedTurns } from "./refused-turn-pruning.js"

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

const refused = (errorMessage = "Provider finish_reason: content_filter") =>
	assistant("I'm sorry, I can't assist with this request.", { stopReason: "error", errorMessage })

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

	it.each([
		["OpenAI content_filter", "Provider finish_reason: content_filter"],
		["display-rewritten content filter", "The request could not be completed (content filter). Please retry."],
		["Anthropic refusal fallback", "The model refused to complete the request"],
	])("recognizes %s", (_name, errorMessage) => {
		expect(pruneRefusedTurns([user("bad"), refused(errorMessage)])).toEqual([])
	})

	it("reads the preserved raw error when the display message was rewritten", () => {
		const message = refused()
		preserveRawErrorMessage(message as { errorMessage?: string })
		Object.assign(message, { errorMessage: "Something went wrong." })

		expect(pruneRefusedTurns([user("bad"), message])).toEqual([])
	})

	it("keeps turns that failed for other reasons", () => {
		const messages = [user("hi"), refused("503 Service Unavailable")]

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

describe("refusedTurnPruningExtension", () => {
	it("rewrites the context only when a refusal is present", async () => {
		const { api, getHandler } = createExtensionApi()
		refusedTurnPruningExtension(api)
		const handler = getHandler<ContextEvent, { messages: AgentMessage[] } | undefined>("context")
		const ctx = createContext()
		const next = user("hi")

		expect(await handler({ type: "context", messages: [user("hi"), assistant("Hi!")] }, ctx)).toBeUndefined()
		expect(await handler({ type: "context", messages: [user("bad"), refused(), next] }, ctx)).toEqual({
			messages: [next],
		})
	})
})
