import type { Message, Model } from "@earendil-works/pi-ai"
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared"
import { stream } from "@earendil-works/pi-ai/api/openai-responses"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import imagePayloadBudgetExtension, {
	IMAGE_PAYLOAD_REMOVED_NOTE,
	trimImagePayloadToBudget,
} from "./image-payload-budget.js"

function bodyBytes(payload: unknown): number {
	return Buffer.byteLength(JSON.stringify(payload))
}

function dataUrl(decodedBytes: number): string {
	return `data:image/png;base64,${Buffer.alloc(decodedBytes, 1).toString("base64")}`
}

function responsesPayload(decodedImageBytes: number[]) {
	return {
		model: "kimi-k2.7",
		stream: true,
		input: decodedImageBytes.map((bytes, index) => ({
			role: "user",
			content: [
				{ type: "input_text", text: `slide ${index}` },
				{ type: "input_image", detail: "auto", image_url: dataUrl(bytes) },
			],
		})),
	}
}

describe("trimImagePayloadToBudget", () => {
	it("replaces only the oldest images needed to fit the exact serialized Responses payload", () => {
		const payload = responsesPayload([2048, 2048, 2048, 2048])
		const originalBytes = bodyBytes(payload)
		const budget = originalBytes - 2000

		const removed = trimImagePayloadToBudget(payload, budget)

		expect(originalBytes).toBeGreaterThan(budget)
		expect(removed).toBe(1)
		expect(bodyBytes(payload)).toBeLessThanOrEqual(budget)
		expect(payload.input[0].content).toEqual([
			{ type: "input_text", text: "slide 0" },
			{ type: "input_text", text: IMAGE_PAYLOAD_REMOVED_NOTE },
		])
		for (const message of payload.input.slice(1)) {
			expect(message.content[0]).toEqual({ type: "input_text", text: expect.stringMatching(/^slide /) })
			expect(message.content[1].type).toBe("input_image")
		}
	})

	it("does not mutate a payload already within budget", () => {
		const payload = responsesPayload([1024])
		const original = structuredClone(payload)

		expect(trimImagePayloadToBudget(payload, bodyBytes(payload))).toBe(0)
		expect(payload).toEqual(original)
	})

	it("removes even the newest image when one image alone exceeds the budget, preserving its text", () => {
		const payload = responsesPayload([4096])

		expect(trimImagePayloadToBudget(payload, 1000)).toBe(1)
		expect(bodyBytes(payload)).toBeLessThanOrEqual(1000)
		expect(payload.input[0].content).toEqual([
			{ type: "input_text", text: "slide 0" },
			{ type: "input_text", text: IMAGE_PAYLOAD_REMOVED_NOTE },
		])
	})

	it("does not serialize payloads without embedded images", () => {
		const payload = {
			messages: [{ role: "user", content: [{ type: "text", text: "text-only request" }] }],
			toJSON() {
				throw new Error("text-only payload should not be serialized")
			},
		}

		expect(trimImagePayloadToBudget(payload, 1)).toBe(0)
	})

	it.each([
		{
			name: "OpenAI chat-completions",
			image: { type: "image_url", image_url: { url: dataUrl(4096) } },
			replacement: { type: "text", text: IMAGE_PAYLOAD_REMOVED_NOTE },
		},
		{
			name: "Anthropic",
			image: { type: "image", source: { type: "base64", data: Buffer.alloc(4096, 1).toString("base64") } },
			replacement: { type: "text", text: IMAGE_PAYLOAD_REMOVED_NOTE },
		},
		{
			name: "Google inlineData",
			image: { inlineData: { mimeType: "image/png", data: Buffer.alloc(4096, 1).toString("base64") } },
			replacement: { text: IMAGE_PAYLOAD_REMOVED_NOTE },
		},
		{
			name: "Mistral imageUrl",
			image: { type: "image_url", imageUrl: dataUrl(4096) },
			replacement: { type: "text", text: IMAGE_PAYLOAD_REMOVED_NOTE },
		},
	])("trims $name blocks with the provider-correct text replacement", ({ image, replacement }) => {
		const payload = { content: [image] }

		expect(bodyBytes(payload)).toBeGreaterThan(1000)
		expect(trimImagePayloadToBudget(payload, 1000)).toBe(1)
		expect(payload.content).toEqual([replacement])
		expect(bodyBytes(payload)).toBeLessThanOrEqual(1000)
	})
})

describe("Google request integration", () => {
	it("removes Gemini 3 function-response media without creating invalid text parts", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "render_diagram",
				isError: false,
				content: [{ type: "image", data: Buffer.alloc(4096, 1).toString("base64"), mimeType: "image/png" }],
				timestamp: 1,
			},
		]
		const model = {
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			maxTokens: 65536,
			input: ["text", "image"],
			output: ["text"],
			reasoning: true,
		} as unknown as Model<"google-generative-ai">
		const contents = convertMessages(model, normalizeContext({ messages }))
		const functionResponse = contents[0]?.parts?.[0]?.functionResponse
		const payload = { contents }

		expect(functionResponse?.parts).toHaveLength(1)
		expect(bodyBytes(payload)).toBeGreaterThan(1000)
		expect(trimImagePayloadToBudget(payload, 1000)).toBe(1)
		expect(bodyBytes(payload)).toBeLessThanOrEqual(1000)
		expect(functionResponse?.parts).toEqual([])
		expect(functionResponse?.response).toEqual({ output: `(see attached image)\n${IMAGE_PAYLOAD_REMOVED_NOTE}` })
	})
})

describe("imagePayloadBudgetExtension", () => {
	it("returns the trimmed payload from its registered hook and undefined for a no-op", async () => {
		const { api, getHandler } = createExtensionApi()
		imagePayloadBudgetExtension(api)
		const handler = getHandler("before_provider_request")
		const oversized = responsesPayload([18 * 1024 * 1024])
		const withinBudget = responsesPayload([16])

		expect(await handler({ payload: oversized }, {} as never)).toBe(oversized)
		expect(oversized.input[0].content[1]).toEqual({ type: "input_text", text: IMAGE_PAYLOAD_REMOVED_NOTE })
		expect(await handler({ payload: withinBudget }, {} as never)).toBeUndefined()
	})
})

describe("OpenAI Responses request integration", () => {
	it("brings the original four-image repro below a 10 MiB mock gateway limit", async () => {
		const budget = 10 * 1024 * 1024
		const images = [2, 2, 2, 2].map((mib) => Buffer.alloc(mib * 1024 * 1024, 1).toString("base64"))
		const messages = images.map((data, index) => ({
			role: "user",
			content: [
				{ type: "text", text: `slide ${index}` },
				{ type: "image", data, mimeType: "image/png" },
			],
		})) as Message[]
		const model = {
			id: "kimi-k2.7",
			name: "kimi-k2.7",
			api: "openai-responses",
			provider: "kimchi-dev",
			baseUrl: "http://localhost:9",
			maxTokens: 131072,
			input: ["text", "image"],
			output: ["text"],
			reasoning: false,
		} as unknown as Model<"openai-responses">
		let originalBytes = 0
		let sentBody: string | undefined
		let streamError: unknown
		const captureFetch = async (_url: unknown, init: unknown) => {
			sentBody = String((init as { body?: unknown })?.body ?? "")
			return new Response(JSON.stringify({ error: { message: "captured" } }), {
				status: 500,
				headers: { "content-type": "application/json" },
			})
		}

		try {
			const events = stream(model, normalizeContext({ systemPrompt: "Summarize the slides.", messages }), {
				apiKey: "replay-key",
				fetch: captureFetch as unknown as typeof fetch,
				onPayload: (payload) => {
					originalBytes = bodyBytes(payload)
					trimImagePayloadToBudget(payload, budget)
					return payload
				},
			})
			for await (const event of events) {
				if (event?.type === "error") {
					streamError = event
					break
				}
			}
		} catch (error) {
			streamError = error
		}

		expect(sentBody, `stream failed before capture: ${JSON.stringify(streamError)}`).toBeDefined()
		expect(originalBytes).toBeGreaterThan(budget)
		expect(bodyBytes(sentBody)).toBeLessThanOrEqual(budget)
		const sent = JSON.parse(sentBody as string) as ReturnType<typeof responsesPayload>
		const userItems = sent.input.filter((item) => item.role === "user")
		expect(userItems.flatMap((item) => item.content).filter((item) => item.type === "input_image")).toHaveLength(3)
		expect(userItems.flatMap((item) => item.content).filter((item) => item.type === "input_text")).toHaveLength(5)
	})
})
