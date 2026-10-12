import { EventEmitter } from "node:events"
import type * as fs from "node:fs"
import {
	type FSWatcher,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	unwatchFile,
	watch,
	watchFile,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { redactValue, startSettingsChangeWatcher } from "./settings-change-emitter.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmittedCall = { event: string; properties: Record<string, string | number | boolean> }

// Inject only filesystem events: snapshots still read real files. OS directory
// watchers can miss writes immediately after registration (notably on macOS),
// so elapsed time is not a reliable readiness signal for these unit tests.
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	watch: vi.fn(),
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
}))

class TestWatcher extends EventEmitter implements FSWatcher {
	close = vi.fn()
	ref(): this {
		return this
	}
	unref(): this {
		return this
	}
}

let watchListener: fs.WatchListener<string> | undefined
let pollListener: fs.StatsListener | undefined

function notifySettingsChange(event: "change" | "rename" = "change", filename = "settings.json"): void {
	if (!watchListener) throw new Error("settings watcher did not register a listener")
	watchListener(event, filename)
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
// startSettingsChangeWatcher — snapshots + event delivery + debounce
// ---------------------------------------------------------------------------

describe("startSettingsChangeWatcher", () => {
	let tmpDir: string
	let watcher: TestWatcher
	let stop: (() => void) | undefined
	let emitted: EmittedCall[]

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-settings-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", tmpDir)
		vi.useFakeTimers()
		watcher = new TestWatcher()
		watchListener = undefined
		vi.mocked(watch).mockReset()
		vi.mocked(watch).mockImplementation((_filename, optionsOrListener, listener?: fs.WatchListener<string>) => {
			watchListener = typeof optionsOrListener === "function" ? optionsOrListener : listener
			return watcher
		})
		pollListener = undefined
		vi.mocked(watchFile).mockReset()
		vi.mocked(watchFile).mockImplementation((_filename, optionsOrListener, listener?: fs.StatsListener) => {
			pollListener = typeof optionsOrListener === "function" ? optionsOrListener : listener
			return watcher
		})
		vi.mocked(unwatchFile).mockReset()
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

		notifySettingsChange()
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

		notifySettingsChange()
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

		notifySettingsChange()
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

		notifySettingsChange()
		await vi.advanceTimersByTimeAsync(200)
		expect(emitted).toHaveLength(0)
	})

	it("debounces a burst of changes into the latest snapshot", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		notifySettingsChange()
		await vi.advanceTimersByTimeAsync(20)
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "default" }))
		notifySettingsChange()
		await vi.advanceTimersByTimeAsync(29)
		expect(emitted).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "default" } }])
	})

	it("reads an atomically replaced settings file on a directory rename event", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "replacement.json"), JSON.stringify({ theme: "light" }))
		renameSync(join(tmpDir, "replacement.json"), join(tmpDir, "settings.json"))
		notifySettingsChange("rename")
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "light" } }])
		expect(watch).toHaveBeenCalledWith(tmpDir, { persistent: false }, expect.any(Function))
	})

	it("ignores changes to unrelated files in the settings directory", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		notifySettingsChange("change", "other.json")
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([])
	})

	it("closes the watcher and cancels a pending emission on stop", async () => {
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ theme: "light" }))
		notifySettingsChange()
		stop()
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([])
		expect(watcher.close).toHaveBeenCalledOnce()
		expect(unwatchFile).toHaveBeenCalledWith(join(tmpDir, "settings.json"), expect.any(Function))
		stop = undefined
	})

	it("recovers a missed native notification through polling without duplicating the later native event", async () => {
		const path = join(tmpDir, "settings.json")
		writeFileSync(path, JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(path, JSON.stringify({ theme: "light" }))
		if (!pollListener) throw new Error("polling backstop was not registered")
		pollListener(statSync(path), statSync(path))
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "light" } }])
		notifySettingsChange()
		await vi.advanceTimersByTimeAsync(30)
		expect(emitted).toHaveLength(1)
		expect(watchFile).toHaveBeenCalledWith(path, { persistent: false, interval: 250 }, expect.any(Function))
	})

	it("returns a no-op stop function when KIMCHI_CODING_AGENT_DIR is unset", () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", undefined)
		const noopStop = startSettingsChangeWatcher(() => {})
		expect(() => noopStop()).not.toThrow()
		expect(watch).not.toHaveBeenCalled()
		expect(watchFile).not.toHaveBeenCalled()
	})

	it("observes the first real settings write immediately after watcher startup", async () => {
		vi.useRealTimers()
		const actualFs = await vi.importActual<typeof fs>("node:fs")
		vi.mocked(watch).mockImplementation(actualFs.watch)
		vi.mocked(watchFile).mockImplementation(actualFs.watchFile)
		vi.mocked(unwatchFile).mockImplementation(actualFs.unwatchFile)
		const path = join(tmpDir, "settings.json")
		writeFileSync(path, JSON.stringify({ theme: "dark" }))
		stop = startSettingsChangeWatcher((event, properties) => emitted.push({ event, properties }))
		writeFileSync(path, JSON.stringify({ theme: "light" }))
		await vi.waitFor(
			() => expect(emitted).toEqual([{ event: "config_changed", properties: { key: "theme", value: "light" } }]),
			{ timeout: 5000 },
		)
	}, 10_000)
})
