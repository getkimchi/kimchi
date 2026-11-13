import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorktree } from "../shared/git/worktree.js"
import { runWorktree } from "./worktree.js"

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

let main: string
let originalCwd: string
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

function logs(): string {
	return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")
}

function errors(): string {
	return errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")
}

beforeEach(async () => {
	main = await realpath(await mkdtemp(join(tmpdir(), "wt-cmd-")))
	originalCwd = process.cwd()
	git(main, ["init", "-q"])
	git(main, ["config", "user.email", "wt@test"])
	git(main, ["config", "user.name", "Worktree Cmd Test"])
	await writeFile(join(main, "README.md"), "# cmd\n")
	git(main, ["add", "README.md"])
	git(main, ["commit", "-q", "-m", "init"])
	process.chdir(main)
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
	process.chdir(originalCwd)
	logSpy.mockRestore()
	errSpy.mockRestore()
	await rm(main, { recursive: true, force: true })
})

describe("kimchi worktree", () => {
	it("list reports nothing when no managed worktrees exist", async () => {
		expect(await runWorktree(["list"])).toBe(0)
		expect(logs()).toContain("No kimchi worktrees")
	})

	it("list prints name, status, branch, path for a clean worktree", async () => {
		await createWorktree({ mainRoot: main, name: "alpha" })
		expect(await runWorktree(["list"])).toBe(0)
		const out = logs()
		expect(out).toContain("alpha")
		expect(out).toContain("clean")
		expect(out).toContain("worktree-alpha")
	})

	it("list --json emits machine-readable rows", async () => {
		await createWorktree({ mainRoot: main, name: "beta" })
		expect(await runWorktree(["list", "--json"])).toBe(0)
		const rows = JSON.parse(logs())
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ name: "beta", branch: "worktree-beta", status: "clean" })
	})

	it("remove refuses a dirty worktree without --force", async () => {
		const created = await createWorktree({ mainRoot: main, name: "gamma" })
		await writeFile(join(created.path, "left.txt"), "work\n")
		expect(await runWorktree(["remove", "gamma"])).toBe(1)
		expect(errors()).toContain("contains work")
		expect(existsSync(created.path)).toBe(true)
	})

	it("remove --force drops a dirty worktree and its branch", async () => {
		const created = await createWorktree({ mainRoot: main, name: "gamma" })
		await writeFile(join(created.path, "left.txt"), "work\n")
		expect(await runWorktree(["remove", "gamma", "--force"])).toBe(0)
		expect(existsSync(created.path)).toBe(false)
		expect(git(main, ["branch", "--list", "worktree-gamma"])).toBe("")
	})

	it("remove deletes a clean worktree and its branch", async () => {
		const created = await createWorktree({ mainRoot: main, name: "delta" })
		expect(await runWorktree(["remove", "delta"])).toBe(0)
		expect(existsSync(created.path)).toBe(false)
		expect(logs()).toContain("Removed worktree delta")
	})

	it("prune removes clean worktrees, keeps ones with work", async () => {
		const clean = await createWorktree({ mainRoot: main, name: "prune-clean" })
		const dirty = await createWorktree({ mainRoot: main, name: "prune-dirty" })
		await writeFile(join(dirty.path, "left.txt"), "work\n")

		expect(await runWorktree(["prune"])).toBe(0)

		expect(existsSync(clean.path)).toBe(false)
		expect(existsSync(dirty.path)).toBe(true)
		expect(logs()).toContain("Pruned prune-clean")
		expect(logs()).toContain("1 removed, 1 kept")
	})

	it("unknown subcommand exits 1 with usage", async () => {
		expect(await runWorktree(["frobnicate"])).toBe(1)
		expect(errors()).toContain("unknown subcommand")
	})
})
