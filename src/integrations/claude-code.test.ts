import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { claudeCodeEnv, injectClaudeCodeEnv } from "./claude-code.js"
import { byId } from "./registry.js"

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

	// claude-code.ts calls register() at module top-level. Vitest caches the
	// import, so the registration runs once per test file when the module is
	// first loaded. We don't reset the registry here — re-registering the
	// same tool would throw, and this suite only needs to read the tool back.

	beforeEach(() => {
		scratchHome = mkdtempSync(join(tmpdir(), "kimchi-claude-test-"))
		// os.homedir() consults $HOME first on POSIX. Pointing it at the
		// scratch dir lets resolveScopePath("global", "~/...") land there
		// without monkey-patching node:os.
		prevHome = process.env.HOME
		process.env.HOME = scratchHome
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(scratchHome, { recursive: true, force: true })
	})

	it("registers itself with the integrations registry on import", () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		expect(tool?.binaryName).toBe("claude")
		expect(tool?.configPath).toBe("~/.claude/settings.json")
	})

	it("write() merges env into ~/.claude/settings.json without clobbering other keys", async () => {
		const settings = join(scratchHome, ".claude", "settings.json")
		mkdirSync(join(scratchHome, ".claude"), { recursive: true })
		writeFileSync(settings, JSON.stringify({ theme: "dark", env: { CUSTOM_FLAG: "yes" } }), "utf-8")

		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "test-key")

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
		await tool?.write("global", "fresh-key")

		const settings = join(scratchHome, ".claude", "settings.json")
		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("fresh-key")
		expect(written.env.OTEL_LOGS_EXPORTER).toBeUndefined()
	})

	it("write() includes OTEL env vars when telemetryEnabled is true", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "key-123", { telemetryEnabled: true })

		const settings = join(scratchHome, ".claude", "settings.json")
		const written = JSON.parse(readFileSync(settings, "utf-8"))
		expect(written.env.OTEL_LOGS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_METRICS_EXPORTER).toBe("otlp")
		expect(written.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=Bearer key-123")
	})

	it("write() does not include OTEL env vars when telemetryEnabled is false", async () => {
		const tool = byId("claudecode")
		expect(tool).toBeDefined()
		await tool?.write("global", "key-456", { telemetryEnabled: false })

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
		await tool?.write("global", "new-key", { telemetryEnabled: false })

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
		await tool?.write("global", "new-key", { telemetryEnabled: false })

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
		await tool?.write("global", "new-key", { telemetryEnabled: false })

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
		await expect(tool?.write("global", "")).rejects.toThrow(/API key/)
	})
})
