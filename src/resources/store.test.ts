import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	getResourceOverride,
	getResourceSettingsPath,
	isResourceEnabled,
	resetResourceOverride,
	setResourceOverride,
} from "./store.js"

let dir: string
let oldAgentDir: string | undefined

describe("resource store", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-resources-"))
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		delete process.env.KIMCHI_CODING_AGENT_DIR
	})

	afterEach(() => {
		if (oldAgentDir === undefined) {
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("uses KIMCHI_CODING_AGENT_DIR settings.json when set", () => {
		process.env.KIMCHI_CODING_AGENT_DIR = dir

		expect(getResourceSettingsPath()).toBe(join(dir, "settings.json"))
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
