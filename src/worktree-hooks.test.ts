import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setProjectScopeTrusted } from "./project-scope-trust.js"
import { emitWorktreeHook, type WorktreeHookSubject } from "./worktree-hooks.js"

let mainRoot: string
let worktreeDir: string
let subject: WorktreeHookSubject

async function writeHooks(config: unknown): Promise<void> {
	await mkdir(join(mainRoot, ".kimchi"), { recursive: true })
	await writeFile(join(mainRoot, ".kimchi", "hooks.json"), JSON.stringify(config))
}

function hookFor(event: string, command: string) {
	return { hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } }
}

async function git(cwd: string, args: string[]): Promise<string> {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

const marker = (): string => join(worktreeDir, "hook-ran.txt")

beforeEach(async () => {
	mainRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-hooks-")))
	await git(mainRoot, ["init", "-q"])
	await git(mainRoot, ["config", "user.email", "wt@test"])
	await git(mainRoot, ["config", "user.name", "Worktree Hooks Test"])
	await writeFile(join(mainRoot, "README.md"), "# hooks\n")
	await git(mainRoot, ["add", "README.md"])
	await git(mainRoot, ["commit", "-q", "-m", "init"])
	worktreeDir = join(mainRoot, ".kimchi", "worktrees", "demo")
	subject = { name: "demo", dir: worktreeDir, branch: "worktree-demo", mainRoot, kind: "user" }
})

afterEach(async () => {
	setProjectScopeTrusted(mainRoot, false)
	await rm(mainRoot, { recursive: true, force: true })
})

describe("emitWorktreeHook", () => {
	it("runs a matching project-scope hook when trusted", async () => {
		await writeHooks(hookFor("WorktreeCreate", `echo create > "${marker()}"`))
		setProjectScopeTrusted(mainRoot, true)
		await mkdir(worktreeDir, { recursive: true })

		await emitWorktreeHook("WorktreeCreate", subject, true)

		expect(existsSync(marker())).toBe(true)
	})

	it("fails closed: project hooks do not run without trust", async () => {
		await writeHooks(hookFor("WorktreeCreate", `echo create > "${marker()}"`))
		setProjectScopeTrusted(mainRoot, false)
		await mkdir(worktreeDir, { recursive: true })

		await emitWorktreeHook("WorktreeCreate", subject, false)

		expect(existsSync(marker())).toBe(false)
	})

	it("ignores hooks for the other worktree event", async () => {
		await writeHooks(hookFor("WorktreeRemove", `echo remove > "${marker()}"`))
		setProjectScopeTrusted(mainRoot, true)
		await mkdir(worktreeDir, { recursive: true })

		await emitWorktreeHook("WorktreeCreate", subject, true)

		expect(existsSync(marker())).toBe(false)
	})

	it("never throws on a malformed hooks file", async () => {
		await mkdir(join(mainRoot, ".kimchi"), { recursive: true })
		await writeFile(join(mainRoot, ".kimchi", "hooks.json"), "{ not json")
		setProjectScopeTrusted(mainRoot, true)

		await expect(emitWorktreeHook("WorktreeCreate", subject, true)).resolves.toBeUndefined()
	})
})
