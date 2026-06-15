import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveScopePath } from "../config/scope.js"
import { TEST_MODELS } from "./__fixtures__/models.js"
import { buildDroidCustomModels, writeDroidConfig } from "./droid.js"
import { byId } from "./registry.js"

const BASE_URL = "https://llm.kimchi.dev/openai/v1"
const ANTHROPIC_BASE_URL = "https://llm.kimchi.dev/anthropic"

describe("buildDroidCustomModels", () => {
	it("emits one customModels entry per model with the BYOK field shape", () => {
		const entries = buildDroidCustomModels(undefined, "test-key", TEST_MODELS)
		expect(entries.length).toBe(TEST_MODELS.length)
		const kimi = entries.find((e) => e.model === "kimi-k2.6")
		expect(kimi).toEqual({
			model: "kimi-k2.6",
			displayName: "Kimi K2.6",
			baseUrl: BASE_URL,
			apiKey: "test-key",
			provider: "generic-chat-completion-api",
			maxOutputTokens: 32_768,
		})
	})

	it("routes anthropic models to the anthropic provider and base URL", () => {
		const entries = buildDroidCustomModels(undefined, "k", TEST_MODELS)
		const opus = entries.find((e) => e.model === "claude-opus-4-6")
		expect(opus?.provider).toBe("anthropic")
		expect(opus?.baseUrl).toBe(ANTHROPIC_BASE_URL)
	})

	it("preserves user models and replaces prior kimchi entries (idempotent)", () => {
		const existing = [
			{ model: "my-local", displayName: "Local", baseUrl: "http://localhost:11434/v1", provider: "ollama" },
			{ model: "kimi-k2.6", displayName: "stale", baseUrl: BASE_URL, provider: "generic-chat-completion-api" },
		]
		const first = buildDroidCustomModels(existing, "k", TEST_MODELS)
		expect(first.filter((e) => e.model === "my-local").length).toBe(1)
		expect(first.filter((e) => e.model === "kimi-k2.6").length).toBe(1)

		const second = buildDroidCustomModels(first, "k", TEST_MODELS)
		expect(second.length).toBe(first.length)
	})
})

describe("writeDroidConfig", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-droid-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("merges customModels into an existing settings.json and is idempotent", () => {
		const path = join(tempDir, "settings.json")
		writeFileSync(path, JSON.stringify({ theme: "dark" }), "utf-8")

		writeDroidConfig(path, "k", TEST_MODELS)
		const first = JSON.parse(readFileSync(path, "utf-8")) as { theme: string; customModels: unknown[] }
		expect(first.theme).toBe("dark")
		expect(first.customModels.length).toBe(TEST_MODELS.length)

		writeDroidConfig(path, "k", TEST_MODELS)
		const second = JSON.parse(readFileSync(path, "utf-8")) as { customModels: unknown[] }
		expect(second.customModels.length).toBe(TEST_MODELS.length)
	})
})

describe("droid integration", () => {
	it("is registered under the kimchi config path", () => {
		const tool = byId("droid")
		expect(tool?.name).toBe("Droid")
		expect(tool?.configPath).toBe("~/.factory/settings.json")
	})

	it("writes at global scope only so it never collides with Claude Code's project settings.json", () => {
		// Droid and Claude Code share the basename settings.json, so in project
		// scope both resolve to <cwd>/.claude/settings.json — the reason the
		// writer ignores scope and always targets the global factory path.
		expect(resolveScopePath("project", "~/.factory/settings.json")).toBe(
			resolveScopePath("project", "~/.claude/settings.json"),
		)
		expect(resolveScopePath("global", "~/.factory/settings.json")).not.toBe(
			resolveScopePath("global", "~/.claude/settings.json"),
		)
	})

	it("rejects an empty API key before touching the filesystem", async () => {
		const tool = byId("droid")
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow("API key not configured")
	})

	it("rejects an empty model list before touching the filesystem", async () => {
		const tool = byId("droid")
		await expect(tool?.write("global", "k", [])).rejects.toThrow("No models available")
	})
})
