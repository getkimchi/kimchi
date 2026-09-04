import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TEST_MODELS } from "./__fixtures__/models.js"
import { buildCodexToml, buildModelCatalog, mergeCodexToml } from "./codex.js"
import { byId } from "./registry.js"

describe("buildCodexToml", () => {
	it("emits the three top-level keys Codex needs", () => {
		const out = buildCodexToml("test-key", "kimi-k2.6", "/home/u/.codex/model_catalog.json")
		expect(out).toMatch(/^model_provider = "kimchi"\n/m)
		expect(out).toMatch(/^model = "kimi-k2\.6"\n/m)
		expect(out).toMatch(/^model_catalog_json = "\/home\/u\/\.codex\/model_catalog\.json"\n/m)
	})

	it("emits the [model_providers.kimchi] table with the gateway endpoints", () => {
		const out = buildCodexToml("test-key", "kimi-k2.6", "/catalog.json")
		expect(out).toContain("[model_providers.kimchi]")
		expect(out).toMatch(/name = "Kimchi Gateway"/)
		expect(out).toMatch(/base_url = "https:\/\/llm\.kimchi\.dev\/openai\/v1"/)
		expect(out).toMatch(/http_headers = \{ Authorization = "Bearer test-key" \}/)
		expect(out).toMatch(/wire_api = "responses"/)
	})

	it("preserves slashes and dots in the catalog path without quoting them as TOML escapes", () => {
		const out = buildCodexToml("k", "kimi-k2.6", "/Users/me/.codex/model_catalog.json")
		// Path should appear literally (no \\/ escapes).
		expect(out).toContain('model_catalog_json = "/Users/me/.codex/model_catalog.json"')
	})
})

describe("mergeCodexToml", () => {
	it("returns the fresh TOML unchanged when existingText is empty", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		expect(mergeCodexToml("", fresh)).toBe(fresh)
	})

	it("returns the fresh TOML when existingText only contains the kimchi provider section", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `[model_providers.kimchi]
name = "Kimchi Gateway"
base_url = "https://llm.kimchi.dev/openai/v1"
http_headers = { Authorization = "Bearer old-key" }
wire_api = "responses"
`
		const merged = mergeCodexToml(existing, fresh)
		expect(merged).toBe(fresh)
	})

	it('preserves user-owned sections like [features] and [plugins."foo"]', () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `model_provider = "kimchi"
model = "kimi-k2.6"
model_catalog_json = "/catalog.json"

[plugins."foo"]
enabled = true

[model_providers.kimchi]
name = "Kimchi Gateway"
base_url = "https://llm.kimchi.dev/openai/v1"
http_headers = { Authorization = "Bearer old-key" }
wire_api = "responses"

[features]
multi_agent = true

[projects]
root = "/Users/me/code"
`

		const merged = mergeCodexToml(existing, fresh)
		expect(merged).toContain('[plugins."foo"]')
		expect(merged).toContain("[features]")
		expect(merged).toContain("[projects]")
		expect(merged).toContain("enabled = true")
		expect(merged).toContain("multi_agent = true")
		expect(merged).toContain('root = "/Users/me/code"')
	})

	it("strips old [model_providers.kimchi] section entirely", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `[model_providers.kimchi]
name = "Old Name"
base_url = "https://old.example/v1"
http_headers = { Authorization = "Bearer old-key" }
wire_api = "chat"

[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		expect(merged).not.toContain("Old Name")
		expect(merged).not.toContain("old.example")
		expect(merged).not.toContain("old-key")
		expect(merged).not.toContain('wire_api = "chat"')
		// The fresh block contains exactly one [model_providers.kimchi] header.
		expect(merged.match(/\[model_providers\.kimchi\]/g)?.length).toBe(1)
	})

	it("preserves [[array.of.tables]] sections following the kimchi provider block", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `[model_providers.kimchi]
name = "Old"
base_url = "https://old.example/v1"
http_headers = { Authorization = "Bearer old-key" }
wire_api = "chat"

[[projects]]
name = "my-project"
path = "/Users/me/code"

[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		expect(merged).toContain("[[projects]]")
		expect(merged).toContain('name = "my-project"')
		expect(merged).toContain("[features]")
		expect(merged).not.toContain("old.example")
		expect(merged).not.toContain("old-key")
	})

	it("strips old top-level kimchi keys", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/new-catalog.json")
		const existing = `model_provider = "kimchi"
model = "old-model"
model_catalog_json = "/old-catalog.json"
keep_top_level = "yes"

[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		expect(merged).not.toContain('model = "old-model"')
		expect(merged).not.toContain('model_catalog_json = "/old-catalog.json"')
		// Only one model_provider = line remains — the fresh one.
		const modelProviderLines = merged.match(/^model_provider = .*$/gm) ?? []
		expect(modelProviderLines).toHaveLength(1)
		expect(modelProviderLines[0]).toBe('model_provider = "kimchi"')
		// Fresh top-level values must be present.
		expect(merged).toContain('model = "kimi-k2.6"')
		expect(merged).toContain('model_catalog_json = "/new-catalog.json"')
		// Unrelated top-level keys survive.
		expect(merged).toContain('keep_top_level = "yes"')
	})

	it("does NOT strip same-named keys that live inside a nested table", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `[other_tool]
model = "user-model"
model_provider = "user-provider"

[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		expect(merged).toContain('model = "user-model"')
		expect(merged).toContain('model_provider = "user-provider"')
	})

	it("collapses runs of blank lines to a single blank line", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `model_provider = "kimchi"



model = "kimi-k2.6"




[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		// No more than two consecutive newlines anywhere in the file.
		expect(merged).not.toMatch(/\n{3,}/)
	})

	it("prepends the fresh TOML before preserved user sections", () => {
		const fresh = buildCodexToml("k", "kimi-k2.6", "/catalog.json")
		const existing = `[features]
multi_agent = true
`
		const merged = mergeCodexToml(existing, fresh)
		const freshIdx = merged.indexOf("model_provider")
		const featuresIdx = merged.indexOf("[features]")
		expect(freshIdx).toBeGreaterThanOrEqual(0)
		expect(featuresIdx).toBeGreaterThan(freshIdx)
	})
})

describe("buildModelCatalog", () => {
	it("returns the {models: [...]} envelope shape", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		expect(Array.isArray(catalog.models)).toBe(true)
		expect(catalog.models.length).toBe(TEST_MODELS.length)
	})

	it("copies slug, display_name, and context_window from ModelMetadata", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		const kimi = catalog.models.find((m) => m.slug === "kimi-k2.6")
		expect(kimi).toBeDefined()
		expect(kimi?.display_name).toBe("Kimi K2.6")
		expect(kimi?.context_window).toBe(262_144)
		expect(kimi?.name).toBe("kimi-k2.6")
		expect(kimi?.model).toBe("kimi-k2.6")
	})

	it("uses 'kimchi' as the provider for every entry", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		for (const entry of catalog.models) {
			expect(entry.provider).toBe("kimchi")
		}
	})

	it("sets truncation_policy to { mode: 'tokens', limit: context_window }", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		for (const entry of catalog.models) {
			expect(entry.truncation_policy).toEqual({ mode: "tokens", limit: entry.context_window })
		}
	})

	it("enables tools and parallel tool calls for every model", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		for (const entry of catalog.models) {
			expect(entry.supports_tools).toBe(true)
			expect(entry.supports_parallel_tool_calls).toBe(true)
		}
	})

	it("populates reasoning levels for reasoning models", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		const kimi = catalog.models.find((m) => m.slug === "kimi-k2.6")
		expect(kimi?.supports_reasoning_summaries).toBe(true)
		expect(kimi?.support_verbosity).toBe(true)
		expect(kimi?.supported_reasoning_levels).toEqual([
			{ effort: "low", description: "Low reasoning effort" },
			{ effort: "medium", description: "Medium reasoning effort" },
			{ effort: "high", description: "High reasoning effort" },
		])
	})

	it("emits an empty reasoning_levels array for non-reasoning models", () => {
		const nonReasoning: readonly import("../models.js").ModelMetadata[] = [
			{
				slug: "plain-model",
				display_name: "Plain Model",
				provider: "kimchi",
				reasoning: false,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 8_192, max_output_tokens: 4_096 },
			},
		]
		const catalog = buildModelCatalog(nonReasoning)
		expect(catalog.models[0].supports_reasoning_summaries).toBe(false)
		expect(catalog.models[0].support_verbosity).toBe(false)
		expect(catalog.models[0].supported_reasoning_levels).toEqual([])
	})

	it("assigns priority as (index + 1) * 10 to preserve picker ordering", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		expect(catalog.models[0].priority).toBe(10)
		expect(catalog.models[1].priority).toBe(20)
		expect(catalog.models[2].priority).toBe(30)
	})

	it("sets shell_type to 'shell_command' and visibility to 'list'", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		for (const entry of catalog.models) {
			expect(entry.shell_type).toBe("shell_command")
			expect(entry.visibility).toBe("list")
			expect(entry.supported_in_api).toBe(true)
		}
	})

	it("includes a base instructions prompt", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		expect(catalog.models[0].base_instructions).toBe("You are a helpful coding assistant.")
	})

	it("always emits an empty experimental_supported_tools array", () => {
		const catalog = buildModelCatalog(TEST_MODELS)
		for (const entry of catalog.models) {
			expect(entry.experimental_supported_tools).toEqual([])
		}
	})

	it("produces correct catalog for Slack-thread models (m3, k2.7, glm, deepseek, nemotron)", () => {
		// The exact model set captured in the original Slack thread. Each entry
		// carries the specific context window and reasoning capability that the
		// catalog must reproduce verbatim.
		const SLACK_THREAD_MODELS: readonly import("../models.js").ModelMetadata[] = [
			{
				slug: "minimax-m3",
				display_name: "MiniMax M3",
				provider: "kimchi",
				reasoning: true,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 1_048_576, max_output_tokens: 32_768 },
			},
			{
				slug: "kimi-k2.7",
				display_name: "Kimi K2.7",
				provider: "kimchi",
				reasoning: true,
				input_modalities: ["text", "image"],
				is_serverless: true,
				limits: { context_window: 262_144, max_output_tokens: 32_768 },
			},
			{
				slug: "glm-5.2-fp8",
				display_name: "GLM 5.2 FP8",
				provider: "kimchi",
				reasoning: true,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 1_048_576, max_output_tokens: 32_768 },
			},
			{
				slug: "deepseek-v4-flash",
				display_name: "DeepSeek V4 Flash",
				provider: "kimchi",
				reasoning: false,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 1_048_576, max_output_tokens: 32_768 },
			},
			{
				slug: "nemotron-3-ultra-fp4",
				display_name: "Nemotron 3 Ultra FP4",
				provider: "kimchi",
				reasoning: false,
				input_modalities: ["text"],
				is_serverless: true,
				limits: { context_window: 1_048_576, max_output_tokens: 32_768 },
			},
		]

		const catalog = buildModelCatalog(SLACK_THREAD_MODELS)
		expect(catalog.models).toHaveLength(5)

		// Reasoning models — minimax-m3, kimi-k2.7, glm-5.2-fp8
		const minimax = catalog.models.find((m) => m.slug === "minimax-m3")
		expect(minimax?.context_window).toBe(1_048_576)
		expect(minimax?.supports_reasoning_summaries).toBe(true)
		expect(minimax?.support_verbosity).toBe(true)
		expect(minimax?.supported_reasoning_levels).toHaveLength(3)

		const kimi = catalog.models.find((m) => m.slug === "kimi-k2.7")
		expect(kimi?.context_window).toBe(262_144)
		expect(kimi?.supports_reasoning_summaries).toBe(true)
		expect(kimi?.support_verbosity).toBe(true)
		expect(kimi?.supported_reasoning_levels).toHaveLength(3)

		const glm = catalog.models.find((m) => m.slug === "glm-5.2-fp8")
		expect(glm?.context_window).toBe(1_048_576)
		expect(glm?.supports_reasoning_summaries).toBe(true)
		expect(glm?.support_verbosity).toBe(true)
		expect(glm?.supported_reasoning_levels).toHaveLength(3)

		// Non-reasoning models — deepseek-v4-flash, nemotron-3-ultra-fp4
		const deepseek = catalog.models.find((m) => m.slug === "deepseek-v4-flash")
		expect(deepseek?.context_window).toBe(1_048_576)
		expect(deepseek?.supports_reasoning_summaries).toBe(false)
		expect(deepseek?.support_verbosity).toBe(false)
		expect(deepseek?.supported_reasoning_levels).toEqual([])

		const nemotron = catalog.models.find((m) => m.slug === "nemotron-3-ultra-fp4")
		expect(nemotron?.context_window).toBe(1_048_576)
		expect(nemotron?.supports_reasoning_summaries).toBe(false)
		expect(nemotron?.support_verbosity).toBe(false)
		expect(nemotron?.supported_reasoning_levels).toEqual([])
	})
})

describe("codex tool registration", () => {
	let scratchHome: string
	let prevHome: string | undefined

	beforeEach(() => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-codex-test-"))
		prevHome = process.env.HOME
		process.env.HOME = scratchHome
	})

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("codex")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("codex")
		expect(tool?.configPath).toBe("~/.codex/config.toml")
	})

	it("isInstalled() returns a boolean", () => {
		const tool = byId("codex")
		expect(tool).toBeDefined()
		const value = tool?.isInstalled()
		expect(typeof value).toBe("boolean")
	})

	it("write() rejects an empty API key", async () => {
		const tool = byId("codex")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})

	it("write() merges fresh TOML on top of an existing config.toml", async () => {
		const configDir = join(scratchHome, ".codex")
		mkdirSync(configDir, { recursive: true })
		const configPath = join(configDir, "config.toml")
		writeFileSync(
			configPath,
			`model_provider = "kimchi"
model = "old-model"
model_catalog_json = "/old-catalog.json"

[model_providers.kimchi]
name = "Old"
base_url = "https://old.example/v1"
http_headers = { Authorization = "Bearer old-key" }
wire_api = "chat"

[features]
multi_agent = true
`,
			"utf-8",
		)

		const tool = byId("codex")
		expect(tool).toBeDefined()
		await tool?.write("global", "fresh-key", TEST_MODELS)

		const written = readFileSync(configPath, "utf-8")
		expect(written).toContain('model = "kimi-k2.6"')
		expect(written).not.toContain('model = "old-model"')
		expect(written).not.toContain("old.example")
		expect(written).toContain("[features]")
		expect(written).toContain("multi_agent = true")

		// Catalog must be written alongside config.toml.
		const catalog = JSON.parse(readFileSync(join(configDir, "model_catalog.json"), "utf-8"))
		expect(Array.isArray(catalog.models)).toBe(true)
		expect(catalog.models.length).toBe(TEST_MODELS.length)
	})
})
