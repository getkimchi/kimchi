// extensions/deferred-tools-wire.test.ts
//
// Provider-level guardrail for the cache-stable tool surface: with
// `deferredToolsMode: "kimi"` on the model, a mid-session reveal must NOT
// change the top-level `tools` array on the wire. Revealed tool schemas are
// delivered in-band instead, attached to the toolResult stamped with
// `addedToolNames` (see deferred-reveal.ts).
//
// Exercises the REAL upstream openai-completions implementation via
// streamSimple() with a stubbed fetch capturing the request body:
//   - before reveal: hidden tool absent from params.tools
//   - after reveal (stamped toolResult + tool active in context.tools):
//     params.tools is byte-identical to the pre-reveal array (cache prefix
//     never changes), and the tool schema ships in-band in a system message
//   - without the compat flag (baseline), an active tool always appears in
//     params.tools (proves the test actually exercises the exclusion path)
//
// NOTE: this documents upstream's kimi-mode wire contract, which the kimchi
// gateway does NOT yet support (see the note in models.ts metadataToModel):
// no kimchi model gets the compat flag today. This test stays as the
// contract for the day a compliant path exists.

import type { Context, Model, ToolResultMessage } from "@earendil-works/pi-ai"
import { registerBuiltInApiProviders, streamSimple } from "@earendil-works/pi-ai/compat"
import { describe, expect, it } from "vitest"

registerBuiltInApiProviders()

const KIMI_MODEL: Model<"openai-completions"> = {
	id: "kimi-test",
	name: "Kimi Test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://gateway.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 262144,
	compat: { deferredToolsMode: "kimi" },
}

const BASELINE_MODEL: Model<"openai-completions"> = { ...KIMI_MODEL, compat: undefined }

const ACTIVE_TOOL = { name: "read", description: "read a file", parameters: { type: "object", properties: {} } }
const DEFERRED_TOOL = {
	name: "debug_set_breakpoint",
	description: "set a breakpoint",
	parameters: { type: "object", properties: {} },
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() }
}

function makeToolResult(toolCallId: string, addedToolNames?: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "debug_launch",
		content: [{ type: "text", text: "session started" }],
		details: {},
		isError: false,
		timestamp: Date.now(),
		...(addedToolNames ? { addedToolNames } : {}),
	}
}

function assistantToolCallMessage() {
	return {
		role: "assistant" as const,
		content: [
			{
				type: "toolCall" as const,
				id: "call-1",
				name: "debug_launch",
				arguments: { program: "app.ts" },
			},
		],
		api: "openai-completions" as const,
		provider: "test",
		model: "kimi-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	}
}

/** Runs streamSimple to completion against a capturing fetch stub; returns the parsed request body. */
async function captureRequestBody(model: Model<"openai-completions">, context: Context) {
	let body: Record<string, unknown> | undefined
	const sse = [
		`data: ${JSON.stringify({
			id: "1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-test",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		})}`,
		`data: ${JSON.stringify({
			id: "1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-test",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}`,
		"data: [DONE]",
		"",
	].join("\n\n")

	const fetchStub = async (_url: unknown, init?: { body?: string }) => {
		body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
	}

	const stream = streamSimple(model, context, { apiKey: "test-key", fetch: fetchStub as never })
	for await (const event of stream) {
		if (event.type === "error") throw new Error(`stream failed: ${JSON.stringify(event)}`)
	}
	if (!body) throw new Error("fetch stub was never called")
	return body
}

const wireToolNames = (body: Record<string, unknown>) =>
	((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name)

describe("deferredToolsMode kimi — wire-level tool stability", () => {
	it("hides the revealed tool from params.tools and ships it in-band, keeping the array identical to pre-reveal", async () => {
		// --- Pre-reveal state: deferred tool hidden (not in context.tools)
		const preBody = await captureRequestBody(KIMI_MODEL, {
			systemPrompt: "sys",
			messages: [userMessage("hi"), assistantToolCallMessage(), makeToolResult("call-1")],
			tools: [ACTIVE_TOOL],
		})
		expect(wireToolNames(preBody)).toEqual(["read"])

		// --- Post-reveal state: tool revealed (active) + stamped result in history
		const postBody = await captureRequestBody(KIMI_MODEL, {
			systemPrompt: "sys",
			messages: [userMessage("hi"), assistantToolCallMessage(), makeToolResult("call-1", ["debug_set_breakpoint"])],
			tools: [ACTIVE_TOOL, DEFERRED_TOOL],
		})

		// Top-level tools array is byte-identical to the pre-reveal one.
		expect(postBody.tools).toEqual(preBody.tools)

		// The deferred tool schema ships in-band, attached after the stamped result.
		const messages = postBody.messages as Array<{ role: string; tools?: Array<{ function: { name: string } }> }>
		const inBand = messages.filter((m) => m.role === "system" && m.tools)
		const inBandTools = inBand[0]?.tools ?? []
		expect(inBand).toHaveLength(1)
		expect(inBandTools.map((t) => t.function.name)).toEqual(["debug_set_breakpoint"])
	})

	it("baseline (no compat flag): an active tool always appears in params.tools", async () => {
		const body = await captureRequestBody(BASELINE_MODEL, {
			systemPrompt: "sys",
			messages: [userMessage("hi"), assistantToolCallMessage(), makeToolResult("call-1", ["debug_set_breakpoint"])],
			tools: [ACTIVE_TOOL, DEFERRED_TOOL],
		})
		expect(wireToolNames(body)).toEqual(["read", "debug_set_breakpoint"])
	})
})
