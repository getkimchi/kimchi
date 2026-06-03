import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverCodexHookResources } from "../codex-hook-adapter/definition.js"

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

	it("discovers Codex hooks.json and skips async handlers", () => {
		writeJson(join(dir, "home", ".codex", "hooks.json"), {
			hooks: {
				SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "load-context" }] }],
				Stop: [{ hooks: [{ type: "command", command: "ignored", async: true }] }],
			},
		})

		const hooks = discoverCodexHookResources(join(dir, "project"))

		expect(hooks.map((hook) => hook.id)).toEqual(["hooks.codex.user.session-start.0"])
		expect(hooks[0]?.timeoutMs).toBe(600_000)
	})

	it("honors disableAllHooks in JSON hook configs", () => {
		writeJson(join(dir, "home", ".codex", "hooks.json"), {
			disableAllHooks: true,
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
			},
		})

		expect(discoverCodexHookResources(join(dir, "project"))).toEqual([])
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
