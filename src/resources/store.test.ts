import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	getResourceOverride,
	getResourceSettingsPath,
	isResourceEnabled,
	listResourceSettings,
	readResourceSettings,
	resetResourceOverride,
	setResourceOverride,
} from "./store.js"

let dir: string
let oldAgentDir: string | undefined

describe("resource store", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-resources-"))
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = undefined
	})

	afterEach(() => {
		if (oldAgentDir === undefined) process.env.KIMCHI_CODING_AGENT_DIR = undefined
		else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		rmSync(dir, { recursive: true, force: true })
	})

	it("uses KIMCHI_CODING_AGENT_DIR settings.json when set", () => {
		process.env.KIMCHI_CODING_AGENT_DIR = dir

		expect(getResourceSettingsPath()).toBe(join(dir, "settings.json"))
	})

	it("defaults known resources from definitions", () => {
		const path = tempSettingsPath()

		expect(isResourceEnabled("hooks.rtk-rewrite", path)).toBe(true)
		expect(getResourceOverride("hooks.rtk-rewrite", path)).toBeUndefined()
	})

	it("persists resource overrides without clobbering unrelated settings", () => {
		const path = tempSettingsPath()
		writeJson(path, { theme: "kimchi-minimal", resources: { "tools.web_fetch": false } })

		setResourceOverride("hooks.rtk-rewrite", false, path)

		expect(readResourceSettings(path).resources).toEqual({
			"tools.web_fetch": false,
			"hooks.rtk-rewrite": false,
		})
		expect(JSON.parse(readFileSync(path, "utf-8")).theme).toBe("kimchi-minimal")
		expect(isResourceEnabled("hooks.rtk-rewrite", path)).toBe(false)
	})

	it("reads and lists valid resource ids only", () => {
		const path = tempSettingsPath()
		writeJson(path, {
			resources: {
				"hooks.rtk-rewrite": false,
				"extensions.mcp-adapter": true,
				"unknown.bad": false,
				"tools.web_search": "no",
			},
		})

		expect(readResourceSettings(path).resources).toEqual({
			"hooks.rtk-rewrite": false,
			"extensions.mcp-adapter": true,
		})
		expect(listResourceSettings(path)).toEqual([
			{ id: "extensions.mcp-adapter", enabled: true, overridden: true },
			{ id: "hooks.rtk-rewrite", enabled: false, overridden: true },
		])
	})

	it("resets an override back to the default", () => {
		const path = tempSettingsPath()
		setResourceOverride("tools.web_search", false, path)

		resetResourceOverride("tools.web_search", path)

		expect(getResourceOverride("tools.web_search", path)).toBeUndefined()
		expect(isResourceEnabled("tools.web_search", path)).toBe(true)
	})

	it("removes override when enabled is undefined", () => {
		const path = tempSettingsPath()
		setResourceOverride("plugins.mcp-apps", false, path)
		setResourceOverride("plugins.mcp-apps", undefined, path)

		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({})
		expect(isResourceEnabled("plugins.mcp-apps", path)).toBe(true)
	})

	it("rejects invalid resource ids", () => {
		const path = tempSettingsPath()

		expect(() => getResourceOverride("bad" as never, path)).toThrow("Invalid resource id")
		expect(() => setResourceOverride("agents.foo" as never, false, path)).toThrow("Invalid resource id")
	})
})

function tempSettingsPath(): string {
	return join(dir, "settings.json")
}

function writeJson(path: string, data: unknown): void {
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
