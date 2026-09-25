import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readJson } from "../config/json.js"
import { confirm } from "../setup-wizard/prompt.js"
import { TEST_MODELS } from "./__fixtures__/models.js"
import { claudeCodeEnv, injectClaudeCodeEnv } from "./claude-code.js"
import { byId } from "./registry.js"

vi.mock("../setup-wizard/prompt.js", () => ({ confirm: vi.fn() }))

// Mock detect.js to control findBinary behavior in binary-check tests
vi.mock("../integrations/detect.js", async () => {
	const actual = await vi.importActual<typeof import("../integrations/detect.js")>("../integrations/detect.js")
	return {
		...actual,
		findBinary: vi.fn(() => "/usr/bin/claude"),
		detectBinaryFactory: actual?.detectBinaryFactory ?? vi.fn(() => () => true),
	}
})

// Mock json.js to control readJson/writeJson in validation tests
vi.mock("../config/json.js", async () => {
	const actual = await vi.importActual<typeof import("../config/json.js")>("../config/json.js")
	return {
		readJson: vi.fn(actual.readJson),
		writeJson: vi.fn(actual.writeJson),
	}
})

describe("claudeCodeEnv", () => {
	it("emits the four env vars Claude Code expects, with ANTHROPIC_API_KEY explicitly empty", () => {
		const env = claudeCodeEnv("my-key")
		expect(env).toEqual({
			ANTHROPIC_BASE_URL: "https://llm.kimchi.dev/anthropic",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_AUTH_TOKEN: "my-key",
			CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
		})
	})

	it("accepts a custom base URL for testing", () => {
		const env = claudeCodeEnv("k", "https://example.com/anthropic")
		expect(env.ANTHROPIC_BASE_URL).toBe("https://example.com/anthropic")
	})

	it("includes OTEL env vars when telemetryEnabled is true", () => {
		const env = claudeCodeEnv("my-key", undefined, { telemetryEnabled: true })
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("my-key")
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("https://api.cast.ai/ai-optimizer/v1beta/logs:ingest")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer my-key")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json")
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(env.OTEL_LOGS_EXPORT_INTERVAL).toBe("15000")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe("Authorization=Bearer my-key")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL).toBe("http/json")
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("15000")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe("cumulative")
		expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1")
	})

	it("does not include OTEL env vars when telemetryEnabled is false", () => {
		const env = claudeCodeEnv("my-key", undefined, { telemetryEnabled: false })
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined()
		expect(env.OTEL_METRICS_EXPORTER).toBeUndefined()
	})

	it("does not include OTEL env vars when options is omitted (default)", () => {
		const env = claudeCodeEnv("my-key")
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined()
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined()
		expect(env.OTEL_METRICS_EXPORTER).toBeUndefined()
	})
})

describe("injectClaudeCodeEnv", () => {
	it("merges into an existing env block without removing unrelated keys", () => {
		const env: Record<string, unknown> = { FOO: "bar" }
		injectClaudeCodeEnv(env, "https://b", "k")
		expect(env.FOO).toBe("bar")
		expect(env.ANTHROPIC_BASE_URL).toBe("https://b")
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("k")
	})

	it("overwrites previously set ANTHROPIC_* values", () => {
		const env: Record<string, unknown> = { ANTHROPIC_API_KEY: "old", ANTHROPIC_AUTH_TOKEN: "old" }
		injectClaudeCodeEnv(env, "https://b", "new")
		expect(env.ANTHROPIC_API_KEY).toBe("")
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("new")
	})

	it("adds OTEL env vars when telemetryEnabled is true", () => {
		const env: Record<string, unknown> = {}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: true })
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer k")
	})

	it("does not add OTEL env vars when telemetryEnabled is false", () => {
		const env: Record<string, unknown> = {}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: false })
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined()
		expect(env.OTEL_METRICS_EXPORTER).toBeUndefined()
	})

	it("overwrites previously set OTEL env vars when telemetryEnabled is true", () => {
		const env: Record<string, unknown> = {
			OTEL_LOGS_EXPORTER: "old-exporter",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer old-key",
		}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: true })
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer k")
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp")
	})

	it("removes matching OTEL endpoint/header vars when telemetryEnabled is false", () => {
		const env: Record<string, unknown> = {
			FOO: "bar",
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer k",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer k",
		}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: false })
		expect(env.FOO).toBe("bar")
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBeUndefined()
	})

	it("preserves custom OTEL endpoint/header vars when telemetryEnabled is false", () => {
		const env: Record<string, unknown> = {
			FOO: "bar",
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://my-otel.com/logs",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer my-token",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://my-otel.com/metrics",
			OTEL_EXPORTER_OTLP_METRICS_HEADERS: "X-Api-Key=abc",
		}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: false })
		expect(env.FOO).toBe("bar")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("https://my-otel.com/logs")
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer my-token")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("https://my-otel.com/metrics")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe("X-Api-Key=abc")
	})

	it("removes Cast AI endpoint but keeps custom headers when telemetryEnabled is false", () => {
		const env: Record<string, unknown> = {
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "X-Api-Key=custom",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Basic base64",
		}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: false })
		expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("X-Api-Key=custom")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe("Authorization=Basic base64")
	})

	it("preserves all non-endpoint OTEL vars when telemetryEnabled is false", () => {
		const env: Record<string, unknown> = {
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer old-key",
			OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORT_INTERVAL: "15000",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer old-key",
			OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_METRIC_EXPORT_INTERVAL: "15000",
			OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative",
			OTEL_LOG_TOOL_DETAILS: "1",
		}
		injectClaudeCodeEnv(env, "https://b", "k", { telemetryEnabled: false })
		// The 4 Cast-AI-specific endpoint+header keys are removed
		expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
		expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBeUndefined()

		// The other 9 OTEL vars remain intact
		expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json")
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(env.OTEL_LOGS_EXPORT_INTERVAL).toBe("15000")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL).toBe("http/json")
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("15000")
		expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe("cumulative")
		expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1")
	})
})

describe("claude-code tool registration", () => {
	let scratchHome: string
	let prevHome: string | undefined

	beforeEach(async () => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-claude-test-"))
		prevHome = process.env.HOME
		process.env.HOME = scratchHome
		// Default: findBinary returns a valid path so existing tests pass
		const { findBinary } = await import("../integrations/detect.js")
		vi.mocked(findBinary).mockReturnValue(join(scratchHome, "bin", "claude"))
	})

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("claude")
		expect(tool?.configPath).toBe("~/.claude/settings.json")
		expect(tool?.interactiveWrite).toBe(true)
	})

	it("write() merges env into ~/.claude/settings.json without clobbering other keys", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(settings, JSON.stringify({ theme: "dark", env: { CUSTOM_FLAG: "yes" } }), "utf-8")

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "test-key", TEST_MODELS)

		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.theme).toBe("dark")
		expect(written.env.CUSTOM_FLAG).toBe("yes")
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("test-key")
		expect(written.env.ANTHROPIC_API_KEY).toBe("")
		expect(written.env.ANTHROPIC_BASE_URL).toBe("https://llm.kimchi.dev/anthropic")
		expect(written.env.OTEL_LOGS_EXPORTER).toBeUndefined()
	})

	it("write() creates the directory and file when they don't exist yet", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "fresh-key", TEST_MODELS)

		const settings = join(scratchHome, ".claude", "settings.json")
		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("fresh-key")
		expect(written.env.OTEL_LOGS_EXPORTER).toBeUndefined()
	})

	it("write() includes OTEL env vars when telemetryEnabled is true", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "key-123", TEST_MODELS, { telemetryEnabled: true })

		const settings = join(scratchHome, ".claude", "settings.json")
		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer key-123")
	})

	it("write() does not include OTEL env vars when telemetryEnabled is false", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "key-456", TEST_MODELS, { telemetryEnabled: false })

		const settings = join(scratchHome, ".claude", "settings.json")
		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.OTEL_LOGS_EXPORTER).toBeUndefined()
		expect(written.env.OTEL_METRICS_EXPORTER).toBeUndefined()
	})

	it("write() removes matching Cast AI OTEL vars when telemetry is disabled after previously enabled", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(
			settings,
			JSON.stringify({
				env: {
					ANTHROPIC_AUTH_TOKEN: "old-key",
					CLAUDE_CODE_ENABLE_TELEMETRY: "1",
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
					OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer old-key",
					OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
					OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer old-key",
					CUSTOM_FLAG: "yes",
				},
			}),
			"utf-8",
		)

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "new-key", TEST_MODELS, { telemetryEnabled: false })

		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("new-key")
		expect(written.env.CUSTOM_FLAG).toBe("yes")
		expect(written.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBeUndefined()
	})

	it("write() only removes the 4 Cast-AI-specific OTEL vars after previously enabled", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(
			settings,
			JSON.stringify({
				env: {
					ANTHROPIC_AUTH_TOKEN: "old-key",
					CLAUDE_CODE_ENABLE_TELEMETRY: "1",
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
					OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer old-key",
					OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
					OTEL_LOGS_EXPORTER: "otlp",
					OTEL_LOGS_EXPORT_INTERVAL: "15000",
					OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
					OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer old-key",
					OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
					OTEL_METRICS_EXPORTER: "otlp",
					OTEL_METRIC_EXPORT_INTERVAL: "15000",
					OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative",
					OTEL_LOG_TOOL_DETAILS: "1",
					CUSTOM_FLAG: "yes",
				},
			}),
			"utf-8",
		)

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "new-key", TEST_MODELS, { telemetryEnabled: false })

		const written = JSON.parse(readFileSync(settings, "utf-8"))
		// The 4 Cast-AI-specific keys should be gone
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBeUndefined()

		// Base key and custom flag preserved
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("new-key")
		expect(written.env.CUSTOM_FLAG).toBe("yes")

		// All the other OTEL vars should still be present
		expect(written.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe("http/json")
		expect(written.env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_LOGS_EXPORT_INTERVAL).toBe("15000")
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL).toBe("http/json")
		expect(written.env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_METRIC_EXPORT_INTERVAL).toBe("15000")
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe("cumulative")
		expect(written.env.OTEL_LOG_TOOL_DETAILS).toBe("1")
	})

	it("write() preserves custom OTEL vars when telemetry is disabled", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(
			settings,
			JSON.stringify({
				env: {
					ANTHROPIC_AUTH_TOKEN: "old-key",
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://my-otel.com/logs",
					OTEL_EXPORTER_OTLP_LOGS_HEADERS: "X-Api-Key=custom",
					OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://my-otel.com/metrics",
					OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer my-token",
					CUSTOM_FLAG: "yes",
				},
			}),
			"utf-8",
		)

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "new-key", TEST_MODELS, { telemetryEnabled: false })

		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("new-key")
		expect(written.env.CUSTOM_FLAG).toBe("yes")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("https://my-otel.com/logs")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("X-Api-Key=custom")
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("https://my-otel.com/metrics")
		expect(written.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe("Authorization=Bearer my-token")
	})

	it("write() rejects an empty API key", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "", TEST_MODELS)).rejects.toThrow(/API key/)
	})

	it("write() rejects when claude binary is not found", async () => {
		const { findBinary } = await import("../integrations/detect.js")
		vi.mocked(findBinary).mockReturnValue(undefined)

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "test-key", TEST_MODELS)).rejects.toThrow(
			/Claude Code is not installed or not on PATH/,
		)
	})

	it("write() rejects when the written file has a malformed env (not an object)", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		// Pre-write a valid file so the initial read succeeds
		writeFileSync(settings, JSON.stringify({ env: {} }), "utf-8")

		const { readJson } = await import("../config/json.js")
		// First read returns valid env; re-read (post-write validation) returns array for env
		vi.mocked(readJson).mockReturnValueOnce({ env: {} }).mockReturnValueOnce({ env: [] })

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "test-key", TEST_MODELS)).rejects.toThrow(/Claude Code config validation failed/)
	})

	it("write() rejects when ANTHROPIC_AUTH_TOKEN is missing after write", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(settings, JSON.stringify({ env: {} }), "utf-8")

		const { readJson } = await import("../config/json.js")
		// First read returns empty env; re-read (post-write) returns valid env without AUTH_TOKEN
		vi.mocked(readJson)
			.mockReturnValueOnce({ env: {} })
			.mockReturnValueOnce({ env: { ANTHROPIC_BASE_URL: "https://llm.kimchi.dev/anthropic" } })

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "test-key", TEST_MODELS)).rejects.toThrow(
			/ANTHROPIC_AUTH_TOKEN must be a non-empty string/,
		)
	})

	it("write() rejects when ANTHROPIC_BASE_URL is missing after write", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(settings, JSON.stringify({ env: {} }), "utf-8")

		const { readJson } = await import("../config/json.js")
		// First read returns empty env; re-read (post-write) returns valid env without BASE_URL
		vi.mocked(readJson)
			.mockReturnValueOnce({ env: {} })
			.mockReturnValueOnce({ env: { ANTHROPIC_AUTH_TOKEN: "test-key" } })

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "test-key", TEST_MODELS)).rejects.toThrow(
			/ANTHROPIC_BASE_URL must be a non-empty string/,
		)
	})

	it("write() rejects when ANTHROPIC_API_KEY is not empty after write", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(settings, JSON.stringify({ env: {} }), "utf-8")

		const { readJson } = await import("../config/json.js")
		// First read returns empty env; re-read (post-write) returns env with non-empty API_KEY
		vi.mocked(readJson)
			.mockReturnValueOnce({ env: {} })
			.mockReturnValueOnce({
				env: {
					ANTHROPIC_AUTH_TOKEN: "test-key",
					ANTHROPIC_BASE_URL: "https://llm.kimchi.dev/anthropic",
					ANTHROPIC_API_KEY: "should-be-empty",
				},
			})

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await expect(tool?.write("global", "test-key", TEST_MODELS)).rejects.toThrow(
			/ANTHROPIC_API_KEY must be an empty string/,
		)
	})
})

describe("Claude configuration safety", () => {
	let scratchHome: string
	let settings: string
	const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

	beforeEach(() => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-claude-safety-"))
		vi.stubEnv("HOME", scratchHome)
		settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"))
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
		vi.mocked(confirm).mockResolvedValue({ kind: "next", value: true })
		vi.spyOn(log, "message").mockImplementation(() => {})
		vi.spyOn(log, "warn").mockImplementation(() => {})
		vi.spyOn(log, "info").mockImplementation(() => {})
	})

	afterEach(() => {
		if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty)
		else Reflect.deleteProperty(process.stdin, "isTTY")
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("hides unexpected values even in endpoint and telemetry settings", async () => {
		writeFileSync(
			settings,
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "https://user:proxy-secret@example.com?token=url-secret",
					OTEL_LOGS_EXPORTER: "unexpected-exporter-secret",
					MY_PROXY_CREDENTIALS: "unmodified-secret",
				},
			}),
		)
		await byId("claudecode")?.write("global", "key", TEST_MODELS, { telemetryEnabled: true })
		const preview = JSON.stringify(vi.mocked(log.message).mock.calls)
		for (const secret of ["proxy-secret", "url-secret", "unexpected-exporter-secret", "unmodified-secret"]) {
			expect(preview).not.toContain(secret)
		}
		expect(preview).toContain("https://llm.kimchi.dev/anthropic")
		expect(preview).toContain("[redacted]")
		expect(JSON.parse(readFileSync(settings, "utf8")).env.MY_PROXY_CREDENTIALS).toBe("unmodified-secret")
	})

	it("reports filesystem error codes without exposing the error message", async () => {
		vi.mocked(readJson).mockImplementationOnce(() => {
			throw Object.assign(new Error("private-source-excerpt"), { code: "EACCES" })
		})
		await expect(byId("claudecode")?.write("global", "key", TEST_MODELS)).rejects.toThrow(
			`Could not read Claude Code settings at ${settings} (EACCES). No changes written.`,
		)
	})

	it("still writes an explicit empty API key when other Kimchi settings already match", async () => {
		const env = claudeCodeEnv("key")
		Reflect.deleteProperty(env, "ANTHROPIC_API_KEY")
		writeFileSync(settings, JSON.stringify({ env }))
		await byId("claudecode")?.write("global", "key", TEST_MODELS)
		expect(JSON.parse(readFileSync(settings, "utf8")).env.ANTHROPIC_API_KEY).toBe("")
	})

	it("does not rewrite settings or create another backup when nothing changes", async () => {
		const original = JSON.stringify({ env: claudeCodeEnv("key") })
		writeFileSync(settings, original)
		await byId("claudecode")?.write("global", "key", TEST_MODELS)
		expect(log.info).toHaveBeenCalledWith("Claude Code configuration is already up to date.")
		expect(readFileSync(settings, "utf8")).toBe(original)
		expect(readdirSync(join(scratchHome, ".claude"))).toEqual(["settings.json"])
	})

	it("rejects malformed settings without echoing credentials from parser errors", async () => {
		const original = '{"env": {"ANTHROPIC_AUTH_TOKEN": "private-secret" invalid}}'
		writeFileSync(settings, original)
		await expect(byId("claudecode")?.write("global", "key", TEST_MODELS)).rejects.toThrow(
			`Could not read Claude Code settings at ${settings}. No changes written.`,
		)
		expect(readFileSync(settings, "utf8")).toBe(original)
		expect(readdirSync(join(scratchHome, ".claude"))).toEqual(["settings.json"])
	})

	it.each([
		true,
		false,
	])("redacts old and new credentials, including telemetry headers (telemetry=%s)", async (telemetryEnabled) => {
		writeFileSync(
			settings,
			JSON.stringify({
				env: {
					ANTHROPIC_API_KEY: "old-api-secret",
					ANTHROPIC_AUTH_TOKEN: "old-token-secret",
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
					OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer old-header-secret",
					OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
					OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer old-metrics-secret",
				},
			}),
		)
		await byId("claudecode")?.write("global", "new-api-secret", TEST_MODELS, { telemetryEnabled })
		const output = JSON.stringify([
			vi.mocked(log.message).mock.calls,
			vi.mocked(log.warn).mock.calls,
			vi.mocked(log.info).mock.calls,
		])
		for (const secret of [
			"old-api-secret",
			"old-token-secret",
			"old-header-secret",
			"old-metrics-secret",
			"new-api-secret",
		]) {
			expect(output).not.toContain(secret)
		}
		expect(output).toContain("[redacted]")
		expect(output).toContain("claude.ai connectors")
		expect(output).toContain("kimchi claude")
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }))
		expect(JSON.parse(readFileSync(settings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("new-api-secret")
	})

	it("backs up the exact original bytes and reports how to restore them", async () => {
		const original = '{\n  "theme": "dark", "env": {"CUSTOM": "yes"}\n}\n'
		writeFileSync(settings, original)
		await byId("claudecode")?.write("global", "key", TEST_MODELS)
		const backups = readdirSync(join(scratchHome, ".claude")).filter((name) => name.includes(".bak"))
		expect(backups).toHaveLength(1)
		const backup = join(scratchHome, ".claude", backups[0])
		expect(readFileSync(backup, "utf8")).toBe(original)
		expect(statSync(backup).mode & 0o777).toBe(0o600)
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining(backup))
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Restore"))
	})

	it.each([
		{ kind: "next", value: false },
		{ kind: "cancel" },
	] as const)("leaves settings untouched when confirmation is %j", async (answer) => {
		const original = '{"env":{"CUSTOM":"keep"}}'
		writeFileSync(settings, original)
		vi.mocked(confirm).mockResolvedValue(answer)
		await expect(byId("claudecode")?.write("global", "key", TEST_MODELS)).resolves.toBe("skipped")
		expect(readFileSync(settings, "utf8")).toBe(original)
		expect(readdirSync(join(scratchHome, ".claude"))).toEqual(["settings.json"])
	})
})
