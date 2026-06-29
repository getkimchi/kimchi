import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFermentWorktree, isInsideLinkedWorktree, removeFermentWorktree } from "./worktree-lifecycle.js"

const GIT_TIMEOUT = 10_000

function run(command: string, cwd: string): string {
	return execSync(command, {
		cwd,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT,
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

function initTempRepo(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "worktree-lifecycle-"))
	run("git init", dir)
	run("git config user.name Tester", dir)
	run("git config user.email tester@example.com", dir)
	writeFileSync(resolve(dir, "README.md"), "hello\n")
	run("git add README.md", dir)
	run("git commit -m initial", dir)
	return dir
}

describe("worktree-lifecycle", () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true })
		}
		tempDirs.length = 0
	})

	function tempRepo(): string {
		const dir = initTempRepo()
		tempDirs.push(dir)
		return dir
	}

	describe("createFermentWorktree", () => {
		it("creates a linked worktree on a ferment branch from HEAD", () => {
			const repoRoot = tempRepo()
			const shortId = "abc123"
			const expectedCommit = run("git rev-parse HEAD", repoRoot)
			const expectedPath = resolve(repoRoot, ".worktrees", `ferment-${shortId}`)

			const result = createFermentWorktree(repoRoot, shortId)

			expect(result.path).toBe(expectedPath)
			expect(result.branch).toBe(`ferment/${shortId}`)
			expect(result.commit).toBe(expectedCommit)

			const worktrees = run("git worktree list --porcelain", repoRoot)
			expect(worktrees).toContain(expectedPath)

			const branches = run(`git branch --list ${result.branch}`, repoRoot)
			expect(branches).toContain(result.branch)

			const worktreeHead = run("git rev-parse HEAD", expectedPath)
			expect(worktreeHead).toBe(expectedCommit)
		})
	})

	describe("removeFermentWorktree", () => {
		it("removes the worktree checkout and the branch", () => {
			const repoRoot = tempRepo()
			const result = createFermentWorktree(repoRoot, "rm001")

			const removal = removeFermentWorktree(repoRoot, result.path, result.branch)

			expect(removal.removed).toBe(true)

			const worktrees = run("git worktree list --porcelain", repoRoot)
			expect(worktrees).not.toContain(result.path)

			const branches = run(`git branch --list ${result.branch}`, repoRoot)
			expect(branches).toBe("")
		})
	})

	describe("isInsideLinkedWorktree", () => {
		it("returns true inside a linked worktree and false in the main checkout", () => {
			const repoRoot = tempRepo()
			const result = createFermentWorktree(repoRoot, "linked")

			expect(isInsideLinkedWorktree(result.path)).toBe(true)
			expect(isInsideLinkedWorktree(repoRoot)).toBe(false)
		})
	})
})
