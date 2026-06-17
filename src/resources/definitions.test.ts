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

	it("surfaces Claude Code hooks as individual hook resources", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true })
		writeJson(join(dir, "home", ".claude", "settings.json"), {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "load-context" }] }],
				PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "file-policy" }] }],
			},
		})

		const resources = getResourceDefinitions()
		const hookResources = resources.filter((resource) => resource.kind === "hooks")
		const extensionResources = resources
			.filter((resource) => resource.kind === "extensions")
			.map((resource) => resource.id)

		expect(hookResources.map((resource) => resource.id)).toContain("hooks.claude-code.user.session-start.0")
		expect(resources.find((resource) => resource.id === "hooks.claude-code.user.session-start.0")).toMatchObject({
			label: "Claude Code: SessionStart #0",
			description: expect.stringContaining("User Claude Code SessionStart hook"),
			defaultEnabled: true,
		})
		expect(resources.find((resource) => resource.id === "hooks.claude-code.user.pre-tool-use.0")).toMatchObject({
			label: "Claude Code: PreToolUse Write|Edit",
			description: expect.stringContaining("Matcher: Write|Edit."),
			defaultEnabled: true,
		})
		expect(extensionResources).toContain("extensions.claude-code-hook-adapter")
		expect(extensionResources).toContain("extensions.claude-code-skills")
		expect(extensionResources).toContain("extensions.pi-package-lookup")
		expect(resources.find((resource) => resource.id === "extensions.claude-code-hook-adapter")).toMatchObject({
			defaultEnabled: false,
			restartRequired: true,
		})
		expect(resources.find((resource) => resource.id === "extensions.claude-code-skills")).toMatchObject({
			defaultEnabled: false,
			restartRequired: true,
		})
		expect(resources.find((resource) => resource.id === "extensions.pi-package-lookup")).toMatchObject({
			defaultEnabled: false,
			restartRequired: true,
		})
	})

	it("registers bash-tool-guard as a toggleable extension", () => {
		const resources = getResourceDefinitions()
		const resource = resources.find((r) => r.id === "extensions.bash-tool-guard")
		expect(resource).toMatchObject({
			kind: "extensions",
			label: "Bash-tool guard",
			defaultEnabled: true,
		})
		// Toggling is dynamic — the tool_call handler consults
		// isResourceEnabled on every bash call, so no restart is
		// required when the user flips the /resources toggle.
		expect(resource?.restartRequired).toBeFalsy()
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
