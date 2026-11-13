import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV } from "../worktree-cli.js"
import { readWorktreeRestartRequest } from "../worktree-restart.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import createWorktreeModeExtension from "./worktree-mode.js"

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

let main: string
let agentDir: string
const ENV_BEARS = ["KIMCHI_CODING_AGENT_DIR", KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV] as const
const savedEnv: Record<string, string | undefined> = {}

async function executeTool(name: string, params: unknown, ctxOverrides: Parameters<typeof createContext>[0]) {
	const { api, getRegisteredTool } = createExtensionApi()
	createWorktreeModeExtension()(api)
	const tool = getRegisteredTool(name)
	const shutdown = vi.fn()
	const ctx = createContext({
		cwd: main,
		shutdown,
		sessionManager: { getSessionFile: () => "/tmp/sessions/s1.jsonl" } as never,
		...ctxOverrides,
	})
	const result = await tool.execute("tc-1", params, undefined, undefined, ctx as never)
	const resultText = result.content[0]
	return { result, text: resultText.type === "text" ? resultText.text : "", shutdown }
}

beforeEach(async () => {
	main = await realpath(await mkdtemp(join(tmpdir(), "wt-mode-")))
	agentDir = await mkdtemp(join(tmpdir(), "wt-mode-agent-"))
	for (const key of ENV_BEARS) {
		savedEnv[key] = process.env[key]
		delete process.env[key]
	}
	process.env.KIMCHI_CODING_AGENT_DIR = agentDir
	git(main, ["init", "-q"])
	git(main, ["config", "user.email", "wt@test"])
	git(main, ["config", "user.name", "Worktree Mode Test"])
	await writeFile(join(main, "README.md"), "# mode\n")
	git(main, ["add", "README.md"])
	git(main, ["commit", "-q", "-m", "init"])
})

afterEach(async () => {
	for (const key of ENV_BEARS) {
		if (savedEnv[key] === undefined) delete process.env[key]
		else process.env[key] = savedEnv[key]
	}
	await rm(main, { recursive: true, force: true })
	await rm(agentDir, { recursive: true, force: true })
})

describe("EnterWorktree", () => {
	it("creates the worktree, writes an enter marker, and requests shutdown", async () => {
		const { text, shutdown } = await executeTool("EnterWorktree", { name: "feature-x" }, {})

		expect(existsSync(join(main, ".kimchi", "worktrees", "feature-x", ".git"))).toBe(true)
		const marker = readWorktreeRestartRequest(agentDir)
		expect(marker).toEqual({ direction: "enter", name: "feature-x", sessionFile: "/tmp/sessions/s1.jsonl" })
		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(text).toContain("feature-x")
	})

	it("generates a name when none is given", async () => {
		const { text } = await executeTool("EnterWorktree", {}, {})
		const marker = readWorktreeRestartRequest(agentDir)
		expect(marker?.direction).toBe("enter")
		expect(marker?.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/)
		expect(text).toContain(marker?.name)
	})

	it("refuses when the session is already inside a kimchi worktree", async () => {
		process.env[KIMCHI_WORKTREE_ENV] = join(main, ".kimchi", "worktrees", "existing")
		process.env[KIMCHI_WORKTREE_MAIN_ENV] = main
		const { text, shutdown } = await executeTool("EnterWorktree", { name: "another" }, {})
		expect(text).toContain("Already inside a kimchi worktree")
		expect(shutdown).not.toHaveBeenCalled()
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
	})

	it("refuses without a session file", async () => {
		const { text, shutdown } = await executeTool(
			"EnterWorktree",
			{ name: "feature-x" },
			{ sessionManager: { getSessionFile: () => undefined } as never },
		)
		expect(text).toContain("No session file yet")
		expect(shutdown).not.toHaveBeenCalled()
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
	})
})

describe("ExitWorktree", () => {
	it("writes an exit marker pointing at the main checkout and requests shutdown", async () => {
		process.env[KIMCHI_WORKTREE_ENV] = join(main, ".kimchi", "worktrees", "feature-x")
		process.env[KIMCHI_WORKTREE_MAIN_ENV] = main

		const { text, shutdown } = await executeTool("ExitWorktree", {}, {})

		const marker = readWorktreeRestartRequest(agentDir)
		expect(marker).toEqual({ direction: "exit", mainRoot: main, sessionFile: "/tmp/sessions/s1.jsonl" })
		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(text).toContain(main)
	})

	it("refuses when the session is not in a worktree", async () => {
		const { text, shutdown } = await executeTool("ExitWorktree", {}, {})
		expect(text).toContain("not running inside a worktree")
		expect(shutdown).not.toHaveBeenCalled()
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
	})
})
