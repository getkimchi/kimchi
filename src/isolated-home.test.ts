/**
 * Regression test for the Windows home-leak bug: unit tests must never touch
 * the developer's real home. tests/setup/isolated-home.ts redirects
 * HOME/USERPROFILE and the XDG homes per file; on Windows os.homedir() reads
 * USERPROFILE and ignores HOME, so both are pinned here.
 */
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { getAgentConfigDir } from "./config.js"

function isInsideDir(parent: string, child: string): boolean {
	const rel = relative(parent, child)
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

describe("unit test home isolation", () => {
	it("os.homedir() resolves inside the OS temp dir, not the real user home", () => {
		expect(isInsideDir(tmpdir(), homedir())).toBe(true)
	})

	it("HOME and USERPROFILE both point at the isolated home", () => {
		expect(process.env.HOME).toBe(homedir())
		expect(process.env.USERPROFILE).toBe(homedir())
	})

	it("XDG config/data/cache homes live below the isolated home", () => {
		expect(process.env.XDG_CONFIG_HOME).toBe(join(homedir(), ".config"))
		expect(process.env.XDG_DATA_HOME).toBe(join(homedir(), ".local", "share"))
		expect(process.env.XDG_CACHE_HOME).toBe(join(homedir(), ".cache"))
	})

	it("kimchi config paths captured at module import time resolve into the isolated home", () => {
		// src/config.ts captures AGENT_CONFIG_DIR from homedir() at import time.
		expect(getAgentConfigDir()).toBe(join(homedir(), ".config", "kimchi", "harness"))
		expect(isInsideDir(homedir(), getAgentConfigDir())).toBe(true)
	})
})
