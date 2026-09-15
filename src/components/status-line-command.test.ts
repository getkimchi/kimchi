/**
 * Unit tests for readStatusLineCommand — the footer factory's lookup of a
 * custom status-line command from the harness settings.json. Covers the
 * readJsonCached semantics it gained with the stat-gated read change: JSONC
 * tolerance and the .jsonc sibling fallback.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetJsonCacheForTest } from "../config/json.js"
import { readStatusLineCommand } from "./status-line.js"

// status-line.ts resolves HARNESS_SETTINGS_PATH from homedir() at module
// load, so the mock must be hoisted before the import — the same pattern as
// src/extensions/tags.test.ts. The mocked path is computed at call time.
vi.mock("node:os", async (importOriginal) => {
	const { join } = await import("node:path")
	const mod = await importOriginal<typeof import("node:os")>()
	return {
		...mod,
		homedir: () => join(mod.tmpdir(), `kimchi-statusline-cmd-mock-home-${process.pid}`),
	}
})

const MOCK_HOME = join(tmpdir(), `kimchi-statusline-cmd-mock-home-${process.pid}`)
const HARNESS_DIR = join(MOCK_HOME, ".config", "kimchi", "harness")
const SETTINGS_JSON = join(HARNESS_DIR, "settings.json")
const SETTINGS_JSONC = join(HARNESS_DIR, "settings.jsonc")

beforeEach(() => {
	rmSync(MOCK_HOME, { recursive: true, force: true })
	mkdirSync(HARNESS_DIR, { recursive: true })
	__resetJsonCacheForTest()
})

afterEach(() => {
	rmSync(MOCK_HOME, { recursive: true, force: true })
	__resetJsonCacheForTest()
})

describe("readStatusLineCommand", () => {
	it("extracts a valid statusLine.command", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ statusLine: { command: "/usr/local/bin/status" } }))
		expect(readStatusLineCommand()).toBe("/usr/local/bin/status")
	})

	it("expands a ~/ prefix against the (mocked) home directory", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ statusLine: { command: "~/bin/status" } }))
		expect(readStatusLineCommand()).toBe(join(MOCK_HOME, "bin/status"))
	})

	it("returns null when the settings file is missing", () => {
		expect(readStatusLineCommand()).toBeNull()
	})

	it("returns null for an empty-string command", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ statusLine: { command: "" } }))
		expect(readStatusLineCommand()).toBeNull()
	})

	it("returns null for a non-string command", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ statusLine: { command: 42 } }))
		expect(readStatusLineCommand()).toBeNull()
	})

	it("returns null when statusLine is not an object", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ statusLine: "nope" }))
		expect(readStatusLineCommand()).toBeNull()
	})

	it("returns null when there is no statusLine key", () => {
		writeFileSync(SETTINGS_JSON, JSON.stringify({ theme: "kimchi-minimal" }))
		expect(readStatusLineCommand()).toBeNull()
	})

	it("tolerates JSONC comments in settings.json (new readJsonCached semantics)", () => {
		writeFileSync(SETTINGS_JSON, '// custom status line\n{\n  "statusLine": { "command": "echo hi" }\n}\n')
		expect(readStatusLineCommand()).toBe("echo hi")
	})

	it("falls back to the settings.jsonc sibling when settings.json is absent", () => {
		writeFileSync(SETTINGS_JSONC, JSON.stringify({ statusLine: { command: "fallback-cmd" } }))
		expect(readStatusLineCommand()).toBe("fallback-cmd")
	})
})
