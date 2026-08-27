import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import { streamSimple } from "@earendil-works/pi-ai/compat"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { updateModelsConfig } from "../models.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import omitKimchiMaxTokensExtension, { omitKimchiMaxTokens } from "./omit-kimchi-max-tokens.js"

const KIMI_METADATA = {
	slug: "kimi-k2.7",
	display_name: "Kimi K2.7",
	provider: "ai-enabler",
	reasoning: true,
	input_modalities: ["text"],
	is_serverless: true,
	limits: { context_window: 262_144, max_output_tokens: 262_144 },
}

function openAIStreamResponse(): Response {
	const chunk = {
		id: "completion",
		object: "chat.completion.chunk",
		created: 0,
		model: "kimi-k2.7",
		choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
	}
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	})
}

describe("Kimchi managed request invariants", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-max-tokens-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ models: [KIMI_METADATA] })),
		)
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("registers the request transform", () => {
		const { api, getHandler } = createExtensionApi()
		omitKimchiMaxTokensExtension(api)
		expect(getHandler("before_provider_request")).toBe(omitKimchiMaxTokens)
	})

	it.each([
		["max_completion_tokens", undefined],
		["max_tokens", { maxTokensField: "max_tokens" as const }],
	])("omits Pi's %s field from the outgoing Kimi request", async (_field, compat) => {
		await updateModelsConfig(modelsJsonPath, "test-key")
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const provider = config.providers["kimchi-dev"]
		const model: Model<"openai-completions"> = {
			...provider.models[0],
			provider: "kimchi-dev",
			api: "openai-completions",
			baseUrl: provider.baseUrl,
			...(compat && { compat }),
		}
		let sentPayload: Record<string, unknown> | undefined
		const requestFetch: typeof fetch = async (_input, init) => {
			sentPayload = JSON.parse(String(init?.body))
			return openAIStreamResponse()
		}

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "incident regression", timestamp: Date.now() }] },
			{
				apiKey: "test",
				fetch: requestFetch,
				onPayload: (payload) => omitKimchiMaxTokens({ type: "before_provider_request", payload }, { model }),
			},
		).result()

		expect(sentPayload).toBeDefined()
		expect(sentPayload).not.toHaveProperty("max_completion_tokens")
		expect(sentPayload).not.toHaveProperty("max_tokens")
	})

	it.each([
		"kimchi-dev/anthropic",
		"kimchi-experimental",
	])("omits token limits for the managed %s provider", (provider) => {
		const result = omitKimchiMaxTokens(
			{ type: "before_provider_request", payload: { max_completion_tokens: 10, max_tokens: 10 } },
			{ model: { provider } },
		)
		expect(result).toEqual({})
	})

	it("sends Max as reasoning_effort=max", async () => {
		await updateModelsConfig(modelsJsonPath, "test-key")
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const provider = config.providers["kimchi-dev"]
		const model: Model<"openai-completions"> = {
			...provider.models[0],
			provider: "kimchi-dev",
			api: "openai-completions",
			baseUrl: provider.baseUrl,
		}
		let sentPayload: Record<string, unknown> | undefined
		const requestFetch: typeof fetch = async (_input, init) => {
			sentPayload = JSON.parse(String(init?.body))
			return openAIStreamResponse()
		}

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "reason deeply", timestamp: Date.now() }] },
			{
				apiKey: "test",
				fetch: requestFetch,
				reasoning: "max",
				onPayload: (payload) => omitKimchiMaxTokens({ type: "before_provider_request", payload }, { model }),
			},
		).result()

		expect(sentPayload).toMatchObject({ reasoning_effort: "max" })
	})

	it("leaves non-Kimchi provider payloads unchanged", () => {
		const payload = { max_completion_tokens: 10, messages: [] }
		expect(omitKimchiMaxTokens({ type: "before_provider_request", payload }, { model: { provider: "openai" } })).toBe(
			undefined,
		)
		expect(payload).toEqual({ max_completion_tokens: 10, messages: [] })
	})
})
