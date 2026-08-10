import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { applyCouncilPreset } from "./config.js"
import {
	councilModel,
	createNaturalCouncilStream,
	modelRegistry,
	response,
	TEST_COUNCIL_CONFIG,
} from "./runtime-test-harness.js"

describe("direct Council turns", () => {
	it.each(["fast", "normal", "deep"] as const)("streams text with one lead call in %s", async (preset) => {
		let release!: () => void
		const events: string[] = []
		const completeModel = vi.fn(
			async (
				model: Model<Api>,
				_context: Context,
				_options?: SimpleStreamOptions,
				onTextDelta?: (delta: string, fullText: string) => void,
			): Promise<AssistantMessage> => {
				onTextDelta?.("Hello", "Hello")
				return await new Promise((resolve) => {
					release = () => resolve(response(model, "Hello"))
				})
			},
		)
		const stream = createNaturalCouncilStream({
			config: applyCouncilPreset(TEST_COUNCIL_CONFIG, preset),
			getModelRegistry: () => modelRegistry,
			completeModel,
		})(councilModel, { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] })
		const drain = (async () => {
			for await (const event of stream) events.push(event.type === "text_delta" ? event.delta : event.type)
		})()

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(events).toEqual(["start", "text_start", "Hello"])
		release()
		expect(await stream.result()).toMatchObject({ content: [{ type: "text", text: "Hello" }], stopReason: "stop" })
		await drain
		expect(completeModel).toHaveBeenCalledTimes(1)
		expect(events).toEqual(["start", "text_start", "Hello", "text_end", "done"])
	})

	it("returns a lead tool call without opening fusion", async () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "write-1",
			name: "write",
			arguments: { path: "file.txt", content: "x\n" },
		}
		const completeModel = vi.fn(async (model: Model<Api>, context: Context) =>
			context.tools?.length
				? { ...response(model, ""), content: [call], stopReason: "toolUse" as const }
				: response(model, "done"),
		)
		const result = await createNaturalCouncilStream({
			config: TEST_COUNCIL_CONFIG,
			getModelRegistry: () => modelRegistry,
			completeModel,
		})(councilModel, {
			messages: [{ role: "user", content: "Write it", timestamp: 1 }],
			tools: [{ name: "write", description: "write", parameters: { type: "object" } }],
		}).result()

		expect(result).toMatchObject({ content: [call], stopReason: "toolUse" })
		expect(completeModel).toHaveBeenCalledTimes(1)
	})
})
