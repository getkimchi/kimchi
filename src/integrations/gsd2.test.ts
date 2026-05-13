import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TEST_MODELS } from "./__fixtures__/models.js"
import { buildGsd2KimchiProvider, buildGsd2Preferences } from "./gsd2.js"
import { byId } from "./registry.js"

describe("buildGsd2KimchiProvider", () => {
	it("returns the provider block with apiKey, baseUrl, and defaultModel", () => {
		const p = buildGsd2KimchiProvider("test-key", TEST_MODELS) as {
			apiKey: string
			baseUrl: string
			defaultModel: string
		}
		expect(p.apiKey).toBe("test-key")
		expect(p.baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		// defaultModel is the resolved main model (first serverless vision model).
		expect(p.defaultModel).toBe("kimi-k2.6")
	})

	it("emits all models with cost metadata (Opus/Sonnet billed at sticker, kimchi models free)", () => {
		const p = buildGsd2KimchiProvider("k", TEST_MODELS) as {
			models: Array<{ id: string; cost: { input: number } }>
		}
		expect(p.models.length).toBe(TEST_MODELS.length)
		const opus = p.models.find((m) => m.id === "claude-opus-4-7")
		expect(opus?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
		const sonnet = p.models.find((m) => m.id === "claude-sonnet-4-7")
		expect(sonnet?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
		for (const slug of ["kimi-k2.6", "kimi-k2.5", "nemotron-3-super-fp4", "minimax-m2.7"]) {
			const m = p.models.find((x) => x.id === slug)
			expect(m?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
		}
	})

	it("Kimi models accept text+image input, others text only", () => {
		const p = buildGsd2KimchiProvider("k", TEST_MODELS) as { models: Array<{ id: string; input: string[] }> }
		expect(p.models.find((m) => m.id === "kimi-k2.6")?.input).toEqual(["text", "image"])
		expect(p.models.find((m) => m.id === "kimi-k2.5")?.input).toEqual(["text", "image"])
		expect(p.models.find((m) => m.id === "nemotron-3-super-fp4")?.input).toEqual(["text"])
		expect(p.models.find((m) => m.id === "claude-opus-4-7")?.input).toEqual(["text"])
	})
})

describe("buildGsd2Preferences", () => {
	const prefs = buildGsd2Preferences(TEST_MODELS)

	it("starts and ends with a YAML frontmatter fence", () => {
		expect(prefs.startsWith("---\n")).toBe(true)
		expect(prefs.trimEnd().endsWith("---")).toBe(true)
	})

	it("routes the high-level task buckets to the right model tiers", () => {
		// Opus for planning/validation/auto_supervisor (heavy reasoning); falls back
		// to main (kimi-k2.6) if opus isn't available.
		expect(prefs).toMatch(/planning: kimchi\/(claude-opus-4-7|kimi-k2\.6)/)
		expect(prefs).toMatch(/validation: kimchi\/(claude-opus-4-7|kimi-k2\.6)/)
		expect(prefs).toMatch(/auto_supervisor:\s*\n\s*model: kimchi\/(claude-opus-4-7|kimi-k2\.6)/)
		// Coding model for research + subagent.
		expect(prefs).toContain("research: kimchi/nemotron-3-super-fp4")
		expect(prefs).toContain("subagent: kimchi/nemotron-3-super-fp4")
		// Sub model for execution_simple + discuss.
		expect(prefs).toContain("discuss: kimchi/minimax-m2.7")
		expect(prefs).toContain("execution_simple: kimchi/minimax-m2.7")
	})

	it("uses the new tier_models shape (light → coding, standard → sub, heavy → [main, planning])", () => {
		expect(prefs).toContain("light: kimchi/nemotron-3-super-fp4")
		expect(prefs).toContain("standard: kimchi/minimax-m2.7")
		expect(prefs).toMatch(/heavy:\s*\n\s*- kimchi\/kimi-k2\.6\s*\n\s*- kimchi\/(claude-opus-4-7|kimi-k2\.6)/)
	})

	it("hardcodes the worktree+squash git defaults", () => {
		expect(prefs).toContain("isolation: worktree")
		expect(prefs).toContain("merge_strategy: squash")
	})
})

describe("gsd2 tool registration", () => {
	let tmp: string
	let prevHome: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-gsd2-test-"))
		prevHome = process.env.HOME
		process.env.HOME = tmp
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("gsd2")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("gsd")
		expect(tool?.configPath).toBe("~/.gsd/preferences.md")
	})

	it("write() rejects an empty API key", async () => {
		const tool = byId("gsd2")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})

	it("write() emits both ~/.gsd/agent/models.json and ~/.gsd/preferences.md", async () => {
		const tool = byId("gsd2")
		await tool?.write("global", "secret-123", TEST_MODELS)

		const models = JSON.parse(readFileSync(join(tmp, ".gsd", "agent", "models.json"), "utf-8"))
		expect(models.providers.kimchi.apiKey).toBe("secret-123")

		const prefs = readFileSync(join(tmp, ".gsd", "preferences.md"), "utf-8")
		expect(prefs).toMatch(/planning: kimchi\/(claude-opus-4-7|kimi-k2\.6)/)
	})

	it("write() preserves other providers and top-level keys in models.json", async () => {
		const modelsPath = join(tmp, ".gsd", "agent", "models.json")
		mkdirSync(join(tmp, ".gsd", "agent"), { recursive: true })
		writeFileSync(
			modelsPath,
			JSON.stringify({
				version: 7,
				providers: {
					anthropic: { apiKey: "user-anthropic-key", baseUrl: "https://api.anthropic.com" },
					kimchi: { apiKey: "stale-kimchi-key", legacy: true },
				},
			}),
		)

		const tool = byId("gsd2")
		await tool?.write("global", "fresh-kimchi-key", TEST_MODELS)

		const models = JSON.parse(readFileSync(modelsPath, "utf-8"))
		expect(models.version).toBe(7)
		expect(models.providers.anthropic).toEqual({
			apiKey: "user-anthropic-key",
			baseUrl: "https://api.anthropic.com",
		})
		expect(models.providers.kimchi.apiKey).toBe("fresh-kimchi-key")
		expect(models.providers.kimchi.legacy).toBeUndefined()
	})
})
