import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getResourceDefinitions } from "./definitions.js"

let dir: string
let oldHome: string | undefined
let oldCwd: string

describe("resource definitions", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-resource-defs-"))
		oldHome = process.env.HOME
		oldCwd = process.cwd()
		process.env.HOME = join(dir, "home")
		process.chdir(join(dir))
	})

	afterEach(() => {
		process.chdir(oldCwd)
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("surfaces Claude Code hooks as one disabled extension resource", () => {
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "load-context" }] }],
			},
		})

		const resources = getResourceDefinitions()
		const hookResources = resources.filter((resource) => resource.kind === "hooks").map((resource) => resource.id)
		const extensionResources = resources
			.filter((resource) => resource.kind === "extensions")
			.map((resource) => resource.id)

		expect(hookResources).not.toContain("hooks.claude-code.user.session-start.0")
		expect(extensionResources).toContain("extensions.claude-code-hook-adapter")
		expect(resources.find((resource) => resource.id === "extensions.claude-code-hook-adapter")).toMatchObject({
			defaultEnabled: false,
			restartRequired: true,
		})
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
