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
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("loads user Claude settings even when cwd lacks .claude", () => {
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

		// User-level settings.json always loads (real Claude Code loads user hooks regardless of project structure).
		// settings.local.json at the home level is not a valid source (local scope is project-level only), so its Stop hook is NOT discovered.
		expect(resources).toEqual([
			{
				adapterId: "claude-code",
				async: false,
				command: "load-context",
				env: undefined,
				eventName: "SessionStart",
				id: "hooks.claude-code.user.session-start.0",
				index: 0,
				matcher: undefined,
				path: join(home, ".claude", "settings.json"),
				scope: "user",
				timeoutMs: 60_000,
			},
		])
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
