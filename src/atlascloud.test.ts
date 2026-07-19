import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { injectAtlasCloudProvider, readAtlasCloudModelMetadata, readAtlasCloudModelsFromConfig } from "./atlascloud.js"

describe("injectAtlasCloudProvider", () => {
	let tmpDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-atlascloud-test-"))
		modelsJsonPath = join(tmpDir, "models.json")
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	function readConfig(): {
		providers: Record<string, { apiKey?: string; baseUrl?: string; models?: Array<{ id: string }> }>
	} {
		return JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
	}

	it("writes Atlas Cloud while preserving existing providers", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify(
				{
					providers: {
						"kimchi-dev": { models: [{ id: "kimi-k2.7" }] },
						custom: { models: [{ id: "custom-model" }] },
					},
				},
				null,
				"\t",
			),
			"utf-8",
		)

		injectAtlasCloudProvider(modelsJsonPath)

		const providers = readConfig().providers
		expect(providers["kimchi-dev"]?.models?.map((m) => m.id)).toEqual(["kimi-k2.7"])
		expect(providers.custom?.models?.map((m) => m.id)).toEqual(["custom-model"])
		expect(providers.atlascloud).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.atlascloud.ai/v1",
			apiKey: "$ATLASCLOUD_API_KEY",
			authHeader: true,
		})
		expect(providers.atlascloud?.models?.map((m) => m.id)).toEqual([
			"qwen/qwen3.5-flash",
			"deepseek-ai/deepseek-v4-pro",
		])
	})

	it("does not create models.json when missing unless requested", () => {
		injectAtlasCloudProvider(modelsJsonPath)
		expect(readAtlasCloudModelsFromConfig(modelsJsonPath)).toEqual([])

		injectAtlasCloudProvider(modelsJsonPath, { createIfMissing: true })
		expect(readConfig().providers.atlascloud?.models?.map((m) => m.id)).toEqual([
			"qwen/qwen3.5-flash",
			"deepseek-ai/deepseek-v4-pro",
		])
	})

	it("is idempotent", () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { "kimchi-dev": { models: [] } } }), "utf-8")

		injectAtlasCloudProvider(modelsJsonPath)
		const first = readFileSync(modelsJsonPath, "utf-8")
		injectAtlasCloudProvider(modelsJsonPath)
		const second = readFileSync(modelsJsonPath, "utf-8")

		expect(second).toBe(first)
	})

	it("reads Atlas Cloud model metadata for startup model discovery", () => {
		injectAtlasCloudProvider(modelsJsonPath, { createIfMissing: true })

		expect(readAtlasCloudModelMetadata(modelsJsonPath)).toEqual([
			expect.objectContaining({
				slug: "qwen/qwen3.5-flash",
				display_name: "Qwen3.5 Flash",
				provider: "atlascloud",
				reasoning: false,
				limits: { context_window: 1_000_000, max_output_tokens: 67_072 },
			}),
			expect.objectContaining({
				slug: "deepseek-ai/deepseek-v4-pro",
				display_name: "DeepSeek V4 Pro",
				provider: "atlascloud",
				reasoning: true,
				limits: { context_window: 1_048_576, max_output_tokens: 393_216 },
			}),
		])
	})

	it("is accepted by pi-mono ModelRegistry", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						api: "openai-completions",
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "$KIMCHI_API_KEY",
						models: [],
					},
				},
			}),
			"utf-8",
		)

		injectAtlasCloudProvider(modelsJsonPath)

		const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent")
		const previousKey = process.env.ATLASCLOUD_API_KEY
		process.env.ATLASCLOUD_API_KEY = "test-atlas-key"
		try {
			const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsJsonPath)
			const qwen = registry.find("atlascloud", "qwen/qwen3.5-flash")
			const deepseek = registry.find("atlascloud", "deepseek-ai/deepseek-v4-pro")

			expect(qwen?.baseUrl).toBe("https://api.atlascloud.ai/v1")
			expect(qwen?.api).toBe("openai-completions")
			expect(qwen?.contextWindow).toBe(1_000_000)
			expect(deepseek?.reasoning).toBe(true)
			expect(registry.getError()).toBeUndefined()
			expect(registry.hasConfiguredAuth(qwen as Parameters<typeof registry.hasConfiguredAuth>[0])).toBe(true)
		} finally {
			if (previousKey === undefined) {
				delete process.env.ATLASCLOUD_API_KEY
			} else {
				process.env.ATLASCLOUD_API_KEY = previousKey
			}
		}
	})
})
