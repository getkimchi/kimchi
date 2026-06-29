import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { checkWorktree, isDedicatedWorktree, maybeSwitchToFermentWorktree, pathStartsWith } from "./worktree.js"

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ferment-worktree-test-"))
}

function initTempRepo(): string {
	const dir = createTempDir()
	execSync("git init", { cwd: dir, stdio: "ignore" })
	execSync("git config user.name Tester", { cwd: dir, stdio: "ignore" })
	execSync("git config user.email tester@example.com", { cwd: dir, stdio: "ignore" })
	execSync("echo hello > README.md", { cwd: dir, stdio: "ignore" })
	execSync("git add README.md", { cwd: dir, stdio: "ignore" })
	execSync("git commit -m initial", { cwd: dir, stdio: "ignore" })
	return dir
}

function makeFerment(worktree: { path: string; branch?: string; commit?: string }): Ferment {
	return {
		id: "019f038b-b114-72cd-8756-22a03a5dcbc9",
		name: "Test Ferment",
		status: "planned",
		worktree,
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-06-29T00:00:00.000Z",
		updatedAt: "2026-06-29T00:00:00.000Z",
	} satisfies Ferment
}

describe("pathStartsWith", () => {
	it("returns true for an exact match", () => {
		expect(pathStartsWith("/foo/project", "/foo/project")).toBe(true)
	})

	it("returns true when the child is inside the parent", () => {
		expect(pathStartsWith("/foo/project", "/foo/project/src")).toBe(true)
	})

	it("returns false for unrelated paths", () => {
		expect(pathStartsWith("/foo/project", "/bar/project")).toBe(false)
	})

	it("returns false when the child only shares a string prefix", () => {
		expect(pathStartsWith("/foo/project", "/foo/projectextra")).toBe(false)
	})
})

describe("isDedicatedWorktree", () => {
	it("returns true for a .worktrees/ferment-<id> path", () => {
		const worktree = { path: `/repo/.worktrees${sep}ferment-abc12345` }
		expect(isDedicatedWorktree(worktree)).toBe(true)
	})

	it("returns true for a ferment/* branch even without the dedicated path", () => {
		const worktree = { path: "/repo", branch: "ferment/abc12345" }
		expect(isDedicatedWorktree(worktree)).toBe(true)
	})

	it("returns false for the main checkout", () => {
		const worktree = { path: "/repo", branch: "main" }
		expect(isDedicatedWorktree(worktree)).toBe(false)
	})

	it("returns false for legacy ferments with no branch", () => {
		const worktree = { path: "/repo" }
		expect(isDedicatedWorktree(worktree)).toBe(false)
	})
})

describe("checkWorktree", () => {
	let originalCwd: string
	let tempDirs: string[] = []

	beforeEach(() => {
		originalCwd = process.cwd()
		tempDirs = []
	})

	afterEach(() => {
		process.chdir(originalCwd)
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true })
		}
		tempDirs = []
	})

	function tempDir(): string {
		const dir = createTempDir()
		tempDirs.push(dir)
		return dir
	}

	it("returns ok when cwd equals a dedicated worktree path", () => {
		const root = tempDir()
		const worktreePath = join(root, ".worktrees", "ferment-abc12345")
		mkdirSync(worktreePath, { recursive: true })
		process.chdir(worktreePath)

		const f = makeFerment({ path: worktreePath, branch: "ferment/abc12345" })
		expect(checkWorktree(f).severity).toBe("ok")
	})

	it("returns ok when cwd is a subdirectory of the worktree path", () => {
		const root = tempDir()
		const worktreePath = join(root, ".worktrees", "ferment-abc12345")
		const subdir = join(worktreePath, "src", "nested")
		mkdirSync(subdir, { recursive: true })
		process.chdir(subdir)

		const f = makeFerment({ path: worktreePath, branch: "ferment/abc12345" })
		expect(checkWorktree(f).severity).toBe("ok")
	})

	it("blocks when cwd is unrelated to the worktree path", () => {
		const worktreePath = tempDir()
		const unrelated = tempDir()
		process.chdir(unrelated)

		const f = makeFerment({ path: worktreePath, branch: "main" })
		const result = checkWorktree(f)
		expect(result.severity).toBe("block")
		expect(result.message).toContain(worktreePath)
	})

	it("blocks when cwd only shares a string prefix with the worktree path", () => {
		const parent = tempDir()
		const worktreePath = join(parent, "project")
		const impostor = join(parent, "projectextra")
		mkdirSync(worktreePath, { recursive: true })
		mkdirSync(impostor, { recursive: true })
		process.chdir(impostor)

		const f = makeFerment({ path: worktreePath, branch: "main" })
		expect(checkWorktree(f).severity).toBe("block")
	})

	it("warns when a non-dedicated worktree is on the wrong branch", () => {
		const repoRoot = initTempRepo()
		tempDirs.push(repoRoot)
		process.chdir(repoRoot)

		const f = makeFerment({ path: repoRoot, branch: "expected-branch" })
		const result = checkWorktree(f)
		expect(result.severity).toBe("warn")
		expect(result.message).toContain("expected-branch")
	})

	it("returns ok for a non-dedicated worktree on the matching branch", () => {
		const repoRoot = initTempRepo()
		tempDirs.push(repoRoot)
		process.chdir(repoRoot)

		const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repoRoot,
			encoding: "utf-8",
		}).trim()

		const f = makeFerment({ path: repoRoot, branch: currentBranch })
		expect(checkWorktree(f).severity).toBe("ok")
	})
})

describe("maybeSwitchToFermentWorktree", () => {
	let originalCwd: string
	let tempDirs: string[] = []

	beforeEach(() => {
		originalCwd = process.cwd()
		tempDirs = []
	})

	afterEach(() => {
		process.chdir(originalCwd)
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true })
		}
		tempDirs = []
	})

	function tempDir(): string {
		const dir = createTempDir()
		tempDirs.push(dir)
		return dir
	}

	it("switches cwd into a dedicated ferment worktree", () => {
		const root = tempDir()
		const worktreePath = join(root, ".worktrees", "ferment-abc12345")
		mkdirSync(worktreePath, { recursive: true })
		process.chdir(root)

		const f = makeFerment({ path: worktreePath, branch: "ferment/abc12345" })
		const changed = maybeSwitchToFermentWorktree(f)

		expect(changed).toBe(true)
		expect(realpathSync(process.cwd())).toBe(realpathSync(worktreePath))
	})

	it("is a no-op when cwd is already inside the dedicated worktree", () => {
		const root = tempDir()
		const worktreePath = join(root, ".worktrees", "ferment-abc12345")
		mkdirSync(worktreePath, { recursive: true })
		process.chdir(worktreePath)

		const f = makeFerment({ path: worktreePath, branch: "ferment/abc12345" })
		const changed = maybeSwitchToFermentWorktree(f)

		expect(changed).toBe(false)
		expect(realpathSync(process.cwd())).toBe(realpathSync(worktreePath))
	})

	it("does nothing for ferments using the main checkout", () => {
		const root = tempDir()
		process.chdir(root)

		const f = makeFerment({ path: root, branch: "main" })
		const changed = maybeSwitchToFermentWorktree(f)

		expect(changed).toBe(false)
		expect(realpathSync(process.cwd())).toBe(realpathSync(root))
	})

	it("does nothing when the ferment is undefined", () => {
		const root = tempDir()
		process.chdir(root)

		const changed = maybeSwitchToFermentWorktree(undefined)

		expect(changed).toBe(false)
		expect(realpathSync(process.cwd())).toBe(realpathSync(root))
	})
})
