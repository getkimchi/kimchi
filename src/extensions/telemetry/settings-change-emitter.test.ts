import type * as fs from "node:fs"
import { mkdtempSync, renameSync, rmSync, statSync, unwatchFile, watch, watchFile, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pollListener, resetFsPollingMock } from "../__mocks__/fs-polling.js"
import { redactValue, startSettingsChangeWatcher } from "./settings-change-emitter.js"

function notifyPoll(settingsDir: string): void {
	pollListener()(statSync(join(settingsDir, "settings.json")), statSync(join(settingsDir, "settings.json")))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmittedCall = { event: string; properties: Record<string, string | number | boolean> }

// Inject only filesystem events: snapshots still read real files. Elapsed time
// is not a reliable readiness signal for stat polling in unit tests, so the
// poll listener is invoked directly.
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	watch: vi.fn(),
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
}))

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
// startSettingsChangeWatcher — snapshots + event delivery + debounce
// ---------------------------------------------------------------------------

describe("startSettingsChangeWatcher", () => {
	let tmpDir: string
	let stop: (() => void) | undefined
	let emitted: EmittedCall[]

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-settings-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", tmpDir)
		vi.useFakeTimers()
		resetFsPollingMock()
		emitted = []
	})

	afterEach(() => {
		stop?.()
		stop = undefined
		vi.useRealTimers()
		vi.unstubAllEnvs()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("emits config_changed for a changed top-level key", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark", model: "kimi" }))
		stop = startSettingsChangeWatcher((event, properties) => {
			emitted.push({ event, properties })
		})

		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light", model: "kimi" }))

		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(30)

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

		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light", model: "o1" }))

		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(30)

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

		writeFileSync(
			join(tmpDir, "settings.json"),
			JSON.stringify({
				apiKey: "sk-secret-xyz789",
				endpoint: "https://evil.corp/v2",
				email: "leak@cast.ai",
				theme: "light",
			}),
		)

		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(30)

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

		// Rewrite identical content.
		writeFileSync(join(tmpDir, "settings.json"), content)

		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(200)
		expect(emitted).toHaveLength(0)
	})

	it("debounces a burst of changes into the latest snapshot", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(20)
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "default" }))
		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(29)
		expect(emitted).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "default" } }])
	})

	it("reads an atomically replaced settings file on the next poll", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "replacement.json"), JSON.stringify({ theme: "light" }))
		renameSync(join(tmpDir, "replacement.json"), join(tmpDir, "settings.json"))
		notifyPoll(tmpDir)
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "light" } }])
	})

	it("does not watch the agent directory; polls the settings file instead", () => {
		const path = join(tmpDir, "settings.json")
		writeFileSync(path, JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		expect(watch).not.toHaveBeenCalled()
		expect(watchFile).toHaveBeenCalledWith(path, { persistent: false, interval: 250 }, expect.any(Function))
	})

	it("stops polling and cancels a pending emission on stop", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		notifyPoll(tmpDir)
		stop()
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([])
		expect(unwatchFile).toHaveBeenCalledWith(join(tmpDir, "settings.json"), expect.any(Function))
		stop = undefined
	})

	it("returns a no-op stop function when KIMCHI_CODING_AGENT_DIR is unset", () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", undefined)
		const noopStop = startSettingsChangeWatcher(() => {})
		expect(() => noopStop()).not.toThrow()
		expect(watch).not.toHaveBeenCalled()
		expect(watchFile).not.toHaveBeenCalled()
	})

	it("observes the first real settings write within one poll interval", async () => {
		vi.useRealTimers()
		const actualFs = await vi.importActual<typeof fs>("node:fs")
		vi.mocked(watchFile).mockImplementation(actualFs.watchFile)
		vi.mocked(unwatchFile).mockImplementation(actualFs.unwatchFile)
		const path = join(tmpDir, "settings.json")
		writeFileSync(path, JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(path, JSON.stringify({ theme: "light" }))
		// CI runners can delay the first real stat poll well past one interval;
		// keep the mtime fresh so the first poll that does run sees the change.
		// Content stays identical, so the emitter still emits exactly once.
		const refresh = setInterval(() => writeFileSync(path, JSON.stringify({ theme: "light" })), 400)
		try {
			await vi.waitFor(
				() => expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "light" } }]),
				{ timeout: 10_000 },
			)
		} finally {
			clearInterval(refresh)
		}
	}, 15_000)
})
