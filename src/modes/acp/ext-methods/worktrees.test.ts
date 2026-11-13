import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { handleWorktreeCreate, handleWorktreeList, handleWorktreeRemove } from "./worktrees.js"

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

let main: string

beforeEach(async () => {
	main = await realpath(await mkdtemp(join(tmpdir(), "wt-acp-")))
	git(main, ["init", "-q"])
	git(main, ["config", "user.email", "wt@test"])
	git(main, ["config", "user.name", "ACP Worktrees Test"])
	await writeFile(join(main, "README.md"), "# acp\n")
	git(main, ["add", "README.md"])
	git(main, ["commit", "-q", "-m", "init"])
})

afterEach(async () => {
	await rm(main, { recursive: true, force: true })
})

describe("_kimchi.dev/worktree/* handlers", () => {
	it("create makes a worktree and reports dir/branch/mainRoot", async () => {
		const result = await handleWorktreeCreate({ cwd: main, name: "ide-feature" })
		expect(result.name).toBe("ide-feature")
		expect(result.branch).toBe("worktree-ide-feature")
		expect(result.mainRoot).toBe(main)
		expect(existsSync(join(result.dir, ".git"))).toBe(true)
	})

	it("create auto-names when omitted", async () => {
		const result = await handleWorktreeCreate({ cwd: main })
		expect(result.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/)
	})

	it("create refuses a nested worktree cwd", async () => {
		const first = await handleWorktreeCreate({ cwd: main, name: "outer" })
		await expect(handleWorktreeCreate({ cwd: first.dir, name: "inner" })).rejects.toThrow(/nested worktrees/)
	})

	it("list returns managed worktrees with status", async () => {
		await handleWorktreeCreate({ cwd: main, name: "listed" })
		const { worktrees } = await handleWorktreeList({ cwd: main })
		expect(worktrees).toHaveLength(1)
		expect(worktrees[0]).toMatchObject({ name: "listed", branch: "worktree-listed", status: "clean" })
	})

	it("remove refuses a dirty worktree without force", async () => {
		const created = await handleWorktreeCreate({ cwd: main, name: "dirty-one" })
		await writeFile(join(created.dir, "work.txt"), "unsaved\n")
		await expect(handleWorktreeRemove({ cwd: main, name: "dirty-one" })).rejects.toThrow(/contains work/)
		expect(existsSync(created.dir)).toBe(true)
	})

	it("remove with force drops the worktree and branch", async () => {
		const created = await handleWorktreeCreate({ cwd: main, name: "forced" })
		await writeFile(join(created.dir, "work.txt"), "unsaved\n")
		const result = await handleWorktreeRemove({ cwd: main, name: "forced", force: true })
		expect(result).toEqual({ removed: true })
		expect(existsSync(created.dir)).toBe(false)
		expect(git(main, ["branch", "--list", "worktree-forced"])).toBe("")
	})

	it("handlers validate required params", async () => {
		await expect(handleWorktreeCreate({})).rejects.toThrow(/cwd is required/)
		await expect(handleWorktreeRemove({ cwd: main })).rejects.toThrow(/name is required/)
	})
})
