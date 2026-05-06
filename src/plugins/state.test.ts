import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readPluginState, setPluginEnabled } from "./state.js"

describe("readPluginState", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("returns empty object when config file does not exist", () => {
		const result = readPluginState(configPath)
		expect(result).toEqual({})
	})

	it("does not throw when config file does not exist", () => {
		expect(() => readPluginState(configPath)).not.toThrow()
	})

	it("returns empty object when config file contains invalid JSON", () => {
		writeFileSync(configPath, "{not valid json")
		const result = readPluginState(configPath)
		expect(result).toEqual({})
	})

	it("does not throw when config file contains invalid JSON", () => {
		writeFileSync(configPath, "{not valid json")
		expect(() => readPluginState(configPath)).not.toThrow()
	})

	it("returns plugins field from a valid config file", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "x",
				plugins: { foo: { enabled: true, source: "bundled" } },
			}),
		)
		const result = readPluginState(configPath)
		expect(result).toEqual({ foo: { enabled: true, source: "bundled" } })
	})

	it("does not include apiKey in returned plugin state", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "x",
				plugins: { foo: { enabled: true, source: "bundled" } },
			}),
		)
		const result = readPluginState(configPath)
		expect(result).not.toHaveProperty("apiKey")
	})

	it("returns empty object when config file has no plugins key", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "abc123" }))
		const result = readPluginState(configPath)
		expect(result).toEqual({})
	})

	it("returns plugin entry with path when source is path", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				plugins: {
					bar: { enabled: false, source: "path", path: "/custom/plugin/bar" },
				},
			}),
		)
		const result = readPluginState(configPath)
		expect(result).toEqual({ bar: { enabled: false, source: "path", path: "/custom/plugin/bar" } })
	})
})

describe("setPluginEnabled", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("creates parent directories and file when config does not exist", () => {
		const nestedConfigPath = join(tempDir, "nested", "deep", "config.json")
		setPluginEnabled("myPlugin", true, "bundled", nestedConfigPath)
		expect(existsSync(nestedConfigPath)).toBe(true)
		const raw = JSON.parse(readFileSync(nestedConfigPath, "utf-8"))
		expect(raw).toEqual({ plugins: { myPlugin: { enabled: true, source: "bundled" } } })
	})

	it("preserves existing keys when merging a plugin entry", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "abc123", plugins: {} }))
		setPluginEnabled("myPlugin", true, "bundled", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.apiKey).toBe("abc123")
		expect(raw.plugins.myPlugin).toEqual({ enabled: true, source: "bundled" })
	})

	it("produces identical file content when called twice with the same value (idempotent)", () => {
		setPluginEnabled("myPlugin", true, "bundled", configPath)
		const firstContents = readFileSync(configPath, "utf-8")
		setPluginEnabled("myPlugin", true, "bundled", configPath)
		const secondContents = readFileSync(configPath, "utf-8")
		expect(secondContents).toBe(firstContents)
	})

	it("creates the entry with enabled: false and does not delete it", () => {
		setPluginEnabled("myPlugin", false, "bundled", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.plugins.myPlugin).toEqual({ enabled: false, source: "bundled" })
	})

	it("leaves no .tmp file after a successful write", () => {
		setPluginEnabled("myPlugin", true, "bundled", configPath)
		const tmpFile = `${configPath}.${process.pid}.tmp`
		expect(existsSync(tmpFile)).toBe(false)
		expect(existsSync(configPath)).toBe(true)
	})

	it("writes correct content after the atomic rename", () => {
		setPluginEnabled("myPlugin", true, "bundled", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.plugins.myPlugin).toEqual({ enabled: true, source: "bundled" })
	})

	it("merges multiple plugin entries without overwriting each other", () => {
		setPluginEnabled("pluginA", true, "bundled", configPath)
		setPluginEnabled("pluginB", false, "bundled", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.plugins.pluginA).toEqual({ enabled: true, source: "bundled" })
		expect(raw.plugins.pluginB).toEqual({ enabled: false, source: "bundled" })
	})

	it("updates an existing plugin entry in-place", () => {
		writeFileSync(configPath, JSON.stringify({ plugins: { myPlugin: { enabled: true, source: "bundled" } } }))
		setPluginEnabled("myPlugin", false, "bundled", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.plugins.myPlugin).toEqual({ enabled: false, source: "bundled" })
	})
})
