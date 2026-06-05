import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverClaudeCodeHookResources } from "../claude-code-hook-adapter/definition.js"

let dir: string
let oldHome: string | undefined

describe("hook adapter discovery", () => {
	beforeEach(() => {
		dir = join(tmpdir(), `kimchi-hook-adapters-${process.pid}-${Math.random().toString(16).slice(2)}`)
		mkdirSync(dir, { recursive: true })
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

	it("discovers Claude Code hooks from settings JSON files", () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ matcher: "Bash|Read", hooks: [{ type: "command", command: "guard" }] }],
			},
		})
		writeJson(join(dir, "project", ".claude", "settings.json"), {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "continue-check", async: true }] }],
			},
		})

		const hooks = discoverClaudeCodeHookResources(join(dir, "project"))

		expect(hooks.map((hook) => hook.id)).toEqual([
			"hooks.claude-code.project.stop.0",
			"hooks.claude-code.user.pre-tool-use.0",
		])
		expect(hooks.find((hook) => hook.eventName === "PreToolUse")?.matcher).toBe("Bash|Read")
	})

	it("does not discover project Claude Code hooks when cwd is inside .claude", () => {
		writeJson(join(dir, "project", ".claude", "settings.json"), {
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "prompt-policy" }] }],
				PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "file-policy" }] }],
			},
		})

		const hooks = discoverClaudeCodeHookResources(join(dir, "project", ".claude"))

		expect(hooks).toEqual([])
	})

	it("honors disableAllHooks in JSON hook configs", () => {
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			disableAllHooks: true,
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
			},
		})

		expect(discoverClaudeCodeHookResources(join(dir, "project"))).toEqual([])
	})

	it("honors disableAllHooks across all hook config sources", () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			disableAllHooks: true,
			hooks: {},
		})
		writeJson(join(dir, "project", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "project-guard" }] }],
			},
		})

		expect(discoverClaudeCodeHookResources(join(dir, "project"))).toEqual([])
	})

	it("honors disableAllHooks even when hooks are omitted", () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			disableAllHooks: true,
		})
		writeJson(join(dir, "project", ".claude", "settings.json"), {
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "project-guard" }] }],
			},
		})

		expect(discoverClaudeCodeHookResources(join(dir, "project"))).toEqual([])
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
