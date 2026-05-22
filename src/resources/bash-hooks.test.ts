import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverBashHookResources } from "./bash-hook-discovery.js"
import { applyEnabledBashHooks, parseBashHookOutput } from "./bash-hooks.js"

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}))

const mockExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>

let dir: string
let oldAgentDir: string | undefined

describe("bash hook discovery", () => {
	beforeEach(() => {
		dir = join(tmpdir(), `kimchi-bash-hooks-${process.pid}-${Math.random().toString(16).slice(2)}`)
		mkdirSync(dir, { recursive: true })
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
	})

	afterEach(() => {
		if (oldAgentDir === undefined) process.env.KIMCHI_CODING_AGENT_DIR = undefined
		else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		rmSync(dir, { recursive: true, force: true })
		mockExecFileSync.mockReset()
	})

	it("discovers global and project bash hooks", () => {
		const globalDir = join(dir, "agent", "hooks", "bash")
		const projectDir = join(dir, "project", ".kimchi", "hooks", "bash")
		mkdirSync(globalDir, { recursive: true })
		mkdirSync(projectDir, { recursive: true })
		writeFileSync(join(globalDir, "rewrite.sh"), "echo global\n")
		writeFileSync(join(projectDir, "guard.bash"), "echo project\n")
		writeFileSync(join(projectDir, "notes.txt"), "ignore\n")

		const hooks = discoverBashHookResources(join(dir, "project"))

		expect(hooks.map((hook) => hook.id)).toEqual(["hooks.bash.global.rewrite-sh", "hooks.bash.project.guard-bash"])
		expect(hooks.find((hook) => hook.scope === "global")?.defaultEnabled).toBe(true)
		expect(hooks.find((hook) => hook.scope === "project")?.defaultEnabled).toBe(false)
	})

	it("parses Crush-style updated_input JSON", () => {
		const output = JSON.stringify({
			decision: "allow",
			updated_input: JSON.stringify({ command: "rtk git status" }),
		})

		expect(parseBashHookOutput(output, "git status")).toEqual({ command: "rtk git status" })
	})

	it("parses plain stdout as a command rewrite", () => {
		expect(parseBashHookOutput("git status --short\n", "git status")).toEqual({ command: "git status --short" })
	})

	it("parses block decisions", () => {
		expect(parseBashHookOutput(JSON.stringify({ decision: "block", reason: "no rm" }), "rm -rf .")).toEqual({
			command: "rm -rf .",
			block: true,
			reason: "no rm",
		})
	})

	it("runs enabled global bash hooks in order", () => {
		const globalDir = join(dir, "agent", "hooks", "bash")
		mkdirSync(globalDir, { recursive: true })
		writeFileSync(join(globalDir, "rewrite.sh"), "unused\n")
		mockExecFileSync.mockReturnValueOnce("git status --short\n")

		expect(applyEnabledBashHooks("git status", join(dir, "project"))).toEqual({ command: "git status --short" })
		expect(mockExecFileSync).toHaveBeenCalledOnce()
	})
})
