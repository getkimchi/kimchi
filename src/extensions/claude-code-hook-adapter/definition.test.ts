import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverClaudeCodeHookResources } from "./definition.js"

let dir: string
let oldHome: string | undefined

describe("Claude Code hook discovery", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-hook-def-"))
		oldHome = process.env.HOME
		process.env.HOME = join(dir, "home")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("does not load user Claude settings when cwd lacks .claude", () => {
		const home = process.env.HOME ?? ""
		const cwd = join(home, "work", "project")
		mkdirSync(cwd, { recursive: true })
		writeJson(join(home, ".claude", "settings.json"), {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "load-context" }] }],
			},
		})
		writeJson(join(home, ".claude", "settings.local.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "home-local" }] }],
			},
		})

		const resources = discoverClaudeCodeHookResources(cwd)

		expect(resources).toEqual([])
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
