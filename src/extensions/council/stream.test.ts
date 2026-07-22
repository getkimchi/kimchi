import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { CouncilStreamWriter, councilProgressLabel, virtualizePublicMessage } from "./stream.js"

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const virtualModel = {
	id: "council",
	name: "Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100,
	maxTokens: 10,
} satisfies Model<Api>

describe("Council public stream", () => {
	it("removes private reasoning while preserving tool calls exactly", () => {
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a" } }
		const physical = {
			role: "assistant",
			content: [{ type: "thinking" as const, thinking: "private" }, toolCall],
			api: "openai-completions",
			provider: "physical",
			model: "model",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			responseId: "private-response",
			diagnostics: [],
		} satisfies AssistantMessage

		expect(virtualizePublicMessage(physical, virtualModel, usage)).toMatchObject({
			content: [toolCall],
			api: "kimchi-council",
			provider: "kimchi",
			model: "council",
			responseId: undefined,
			diagnostics: undefined,
		})
	})

	it("emits only one terminal message", async () => {
		const stream = createAssistantMessageEventStream()
		const writer = new CouncilStreamWriter(stream)
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "public" }],
			api: virtualModel.api,
			provider: virtualModel.provider,
			model: virtualModel.id,
			usage,
			stopReason: "stop",
			timestamp: 1,
		} satisfies AssistantMessage

		expect(writer.emit(message)).toBe(true)
		expect(writer.emit({ ...message, content: [{ type: "text", text: "leak" }] })).toBe(false)
		expect(await stream.result()).toMatchObject({ content: [{ type: "text", text: "public" }] })
	})

	it("uses fixed progress labels without model or prompt data", () => {
		expect(councilProgressLabel("reviewing", 1, 3)).toBe("Council: reviewing 1/3")
	})
})
