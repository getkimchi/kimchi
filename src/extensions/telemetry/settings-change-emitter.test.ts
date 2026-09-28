import { mkdtempSync, renameSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { redactValue, startSettingsChangeWatcher } from "./settings-change-emitter.js"

// Wrap node:fs.watch in a passthrough spy so tests can assert the watch
// target. Spreading `actual` keeps every other fs function real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return { ...actual, watch: vi.fn(actual.watch) }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmittedCall = { event: string; properties: Record<string, string | number | boolean> }

/** Poll until predicate is true or timeoutMs elapses. Default exceeds the
 *  watcher's 2s guard interval so guard-based detection always fits, even in
 *  environments where fs.watch events are not delivered. */
async function waitFor(fn: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (fn()) return
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

// ---------------------------------------------------------------------------
// redactValue — pure, deterministic redaction logic
// ---------------------------------------------------------------------------

describe("redactValue", () => {
	it("passes booleans and numbers through unchanged", () => {
		expect(redactValue("count", 5)).toBe(5)
		expect(redactValue("flag", true)).toBe(true)
		expect(redactValue("flag", false)).toBe(false)
	})

	it("redacts URLs", () => {
		expect(redactValue("endpoint", "https://evil.corp/api")).toBe("redacted:url")
		expect(redactValue("endpoint", "http://localhost:8080")).toBe("redacted:url")
	})

	it("redacts emails", () => {
		expect(redactValue("email", "user@cast.ai")).toBe("redacted:email")
	})

	it("redacts secret-bearing key names regardless of value", () => {
		expect(redactValue("apiKey", "abc123")).toBe("redacted:secret")
		expect(redactValue("token", "xyz")).toBe("redacted:secret")
		expect(redactValue("password", "hunter2")).toBe("redacted:secret")
		expect(redactValue("credential", "wibble")).toBe("redacted:secret")
	})

	it("redacts token-like strings with known prefixes (sk-, pk-, ghp_, xox)", () => {
		expect(redactValue("model", "sk-abcdef0123456789abcdef0123456789")).toBe("redacted:secret")
		expect(redactValue("endpoint", "pk_live_abc123")).toBe("redacted:secret")
		expect(redactValue("auth", "Bearer abc123")).toBe("redacted:secret")
		expect(redactValue("token", "ghp_secrettoken")).toBe("redacted:secret")
	})

	it("passes through safe config identifiers including long model IDs", () => {
		expect(redactValue("theme", "dark")).toBe("dark")
		expect(redactValue("model", "kimi-k2")).toBe("kimi-k2")
		expect(redactValue("model", "gemini-1-5-pro-002")).toBe("gemini-1-5-pro-002")
		expect(redactValue("model", "claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514")
	})

	it("redacts objects, arrays, and null as 'redacted:object'", () => {
		expect(redactValue("mcpServers", { foo: "bar" })).toBe("redacted:object")
		expect(redactValue("list", [1, 2, 3])).toBe("redacted:object")
		expect(redactValue("gone", null)).toBe("redacted:object")
	})
})

// ---------------------------------------------------------------------------
// startSettingsChangeWatcher — file-watch + debounce integration
// ---------------------------------------------------------------------------

describe("startSettingsChangeWatcher", () => {
	let tmpDir: string
	let originalAgentDir: string | undefined
	let stop: (() => void) | undefined
	let emitted: EmittedCall[]

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-settings-"))
		originalAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = tmpDir
		emitted = []
	})

	afterEach(() => {
		stop?.()
		stop = undefined
		if (originalAgentDir === undefined) process.env.KIMCHI_CODING_AGENT_DIR = undefined
		else process.env.KIMCHI_CODING_AGENT_DIR = originalAgentDir
	})

	it("emits config_changed for a changed top-level key", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark", model: "kimi" }))
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})
		// Let the watcher register and capture the initial 'previous' snapshot.
		await new Promise((r) => setTimeout(r, 50))

		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light", model: "kimi" }))

		await waitFor(() => emitted.length > 0)

		expect(emitted).toHaveLength(1)
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		const call = emitted[0]!
		expect(call.event).toBe("config_changed")
		expect(call.properties).toEqual({ key: "theme", value: "light" })
	})

	it("emits one event per changed key when multiple keys change", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark", model: "kimi" }))
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})
		await new Promise((r) => setTimeout(r, 50))

		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light", model: "o1" }))

		await waitFor(() => emitted.length >= 2)

		expect(emitted).toHaveLength(2)
		const keys = emitted.map((e) => e.properties.key)
		expect(keys).toEqual(expect.arrayContaining(["theme", "model"]))
	})

	it("does NOT leak secret/PII values into emitted attrs", async () => {
		writeFileSync(
			join(tmpDir, "settings.json"),
			JSON.stringify({
				apiKey: "sk-secret-abc123",
				endpoint: "https://evil.corp/api",
				email: "leak@cast.ai",
				theme: "dark",
			}),
		)
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})
		await new Promise((r) => setTimeout(r, 50))

		writeFileSync(
			join(tmpDir, "settings.json"),
			JSON.stringify({
				apiKey: "sk-secret-xyz789",
				endpoint: "https://evil.corp/v2",
				email: "leak@cast.ai",
				theme: "light",
			}),
		)

		await waitFor(() => emitted.some((e) => e.properties.key === "theme"))

		const dumped = JSON.stringify(emitted)
		// None of the forbidden secret/PII substrings may appear anywhere.
		for (const forbidden of [
			"sk-secret-abc123",
			"sk-secret-xyz789",
			"evil.corp",
			"leak@cast.ai",
			"https://evil.corp",
		]) {
			expect(dumped).not.toContain(forbidden)
		}
		// Changed secret/endpoint keys must be redacted, not raw.
		const apiKeyCall = emitted.find((e) => e.properties.key === "apiKey")
		expect(apiKeyCall?.properties.value).toBe("redacted:secret")
		const endpointCall = emitted.find((e) => e.properties.value === "redacted:url")
		expect(endpointCall).toBeDefined()
		// email is unchanged → no config_changed event for it.
		expect(emitted.find((e) => e.properties.key === "email")).toBeUndefined()
	})

	it("does not emit when the file content is unchanged", async () => {
		const content = JSON.stringify({ theme: "dark" })
		writeFileSync(join(tmpDir, "settings.json"), content)
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})
		await new Promise((r) => setTimeout(r, 50))

		// Rewrite identical content.
		writeFileSync(join(tmpDir, "settings.json"), content)

		// Wait long enough for any debounce + spurious events to settle.
		await new Promise((r) => setTimeout(r, 200))
		expect(emitted).toHaveLength(0)
	})

	it("returns a no-op stop function when KIMCHI_CODING_AGENT_DIR is unset", () => {
		process.env.KIMCHI_CODING_AGENT_DIR = undefined
		const noopStop = startSettingsChangeWatcher(() => {})
		expect(() => noopStop()).not.toThrow()
	})

	it("watches settings.json itself, never the agent directory (startup-cost regression guard)", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})
		await new Promise((r) => setTimeout(r, 50))

		expect(vi.mocked(watch)).toHaveBeenCalledWith(join(tmpDir, "settings.json"), expect.anything(), expect.anything())
		for (const call of vi.mocked(watch).mock.calls) {
			expect(call[0]).not.toBe(tmpDir)
		}
	})

	it("detects a change even when settings.json is atomically replaced", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher(
			(event, properties) => {
				emitted.push({ event, properties })
			},
			{ guardIntervalMs: 20 },
		)
		await new Promise((r) => setTimeout(r, 50))

		// Atomic replace: write temp + rename over the original (new inode).
		writeFileSync(join(tmpDir, "settings.json.tmp"), JSON.stringify({ theme: "light" }))
		renameSync(join(tmpDir, "settings.json.tmp"), join(tmpDir, "settings.json"))

		await waitFor(() => emitted.length > 0)
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(emitted[0]!.properties).toEqual({ key: "theme", value: "light" })
	})

	it("picks up settings.json when it is created after the watcher starts", async () => {
		stop = startSettingsChangeWatcher(
			(event, properties) => {
				emitted.push({ event, properties })
			},
			{ guardIntervalMs: 20 },
		)
		await new Promise((r) => setTimeout(r, 20))

		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))

		await waitFor(() => emitted.length > 0)
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(emitted[0]!.properties).toEqual({ key: "theme", value: "dark" })
	})

	it("stop() tears down the watcher and guard timer (no events afterwards)", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		const stopFn = startSettingsChangeWatcher(
			(event, properties) => {
				emitted.push({ event, properties })
			},
			{ guardIntervalMs: 10 },
		)
		await new Promise((r) => setTimeout(r, 50))

		stopFn()
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		await new Promise((r) => setTimeout(r, 150))

		expect(emitted).toHaveLength(0)
	})
})
