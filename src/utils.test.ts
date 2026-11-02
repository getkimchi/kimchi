import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("getVersion", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("returns 'dev' when package.json has 0.0.0 and no PI_PACKAGE_DIR", async () => {
		// Ensure PI_PACKAGE_DIR is not set so getVersion falls back to workspace package.json
		vi.stubEnv("PI_PACKAGE_DIR", "")
		const { getVersion } = await import("./utils.js")
		const v = getVersion()
		expect(v).toBe("dev")
	})

	it("returns the real version from PI_PACKAGE_DIR package.json", async () => {
		const tmpDir = mkdtempSync(resolve(tmpdir(), "kimchi-test-"))
		writeFileSync(resolve(tmpDir, "package.json"), JSON.stringify({ name: "kimchi-test", version: "1.2.3" }))
		vi.stubEnv("PI_PACKAGE_DIR", tmpDir)
		const { getVersion } = await import("./utils.js")
		const v = getVersion()
		expect(v).toBe("1.2.3")
	})

	it("memoizes the result (returns the same value on repeated calls)", async () => {
		const { getVersion } = await import("./utils.js")
		const v1 = getVersion()
		const v2 = getVersion()
		expect(v1).toBe(v2)
	})
})

describe("refreshGitBranch", () => {
	it("reads the branch from .git/HEAD without spawning git", async () => {
		const { refreshGitBranch } = await import("./utils.js")
		const dir = mkdtempSync(join(tmpdir(), "kimchi-branch-"))
		try {
			mkdirSync(join(dir, ".git"))
			writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature-branch\n")
			let branch: string | undefined | null = null
			refreshGitBranch((value) => {
				branch = value
			}, dir)
			// The direct .git/HEAD read answers before the call returns; a spawned git would not.
			expect(branch).toBe("feature-branch")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports no branch for a detached HEAD without spawning git", async () => {
		const { refreshGitBranch } = await import("./utils.js")
		const dir = mkdtempSync(join(tmpdir(), "kimchi-detached-"))
		try {
			mkdirSync(join(dir, ".git"))
			writeFileSync(join(dir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
			let branch: string | undefined | null = "unset"
			refreshGitBranch((value) => {
				branch = value
			}, dir)
			expect(branch).toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("follows a linked worktree's gitdir pointer", async () => {
		const { refreshGitBranch } = await import("./utils.js")
		const main = mkdtempSync(join(tmpdir(), "kimchi-main-"))
		const worktree = mkdtempSync(join(tmpdir(), "kimchi-worktree-"))
		try {
			mkdirSync(join(main, ".git"))
			writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
			const pointer = join(main, ".git", "worktrees", "wt")
			mkdirSync(pointer, { recursive: true })
			writeFileSync(join(pointer, "HEAD"), "ref: refs/heads/wt-branch\n")
			writeFileSync(join(worktree, ".git"), `gitdir: ${pointer}\n`)
			let branch: string | undefined | null = null
			refreshGitBranch((value) => {
				branch = value
			}, worktree)
			expect(branch).toBe("wt-branch")
		} finally {
			rmSync(main, { recursive: true, force: true })
			rmSync(worktree, { recursive: true, force: true })
		}
	})

	it("falls back to git outside a work tree", async () => {
		const { refreshGitBranch } = await import("./utils.js")
		const dir = mkdtempSync(join(tmpdir(), "kimchi-nogit-"))
		const empty = mkdtempSync(join(tmpdir(), "kimchi-nogit-env-"))
		try {
			// Point GIT_DIR at a non-repository so ancestor .git directories of the temp dir
			// (e.g. a custom TMPDIR inside a checkout) cannot leak their branch into the walk-up.
			vi.stubEnv("GIT_DIR", join(empty, ".git"))
			const branch = await new Promise<string | undefined>((resolve) => refreshGitBranch(resolve, dir))
			expect(branch).toBeUndefined()
		} finally {
			vi.unstubAllEnvs()
			rmSync(dir, { recursive: true, force: true })
			rmSync(empty, { recursive: true, force: true })
		}
	})

	it("defers to git when GIT_DIR redirects the repository", async () => {
		const { refreshGitBranch } = await import("./utils.js")
		const a = mkdtempSync(join(tmpdir(), "kimchi-gitdir-a-"))
		const b = mkdtempSync(join(tmpdir(), "kimchi-gitdir-b-"))
		try {
			execFileSync("git", ["init", "-q"], { cwd: a })
			execFileSync("git", ["checkout", "-q", "-b", "branch-aaa"], { cwd: a })
			execFileSync("git", ["init", "-q"], { cwd: b })
			execFileSync("git", ["checkout", "-q", "-b", "branch-bbb"], { cwd: b })
			vi.stubEnv("GIT_DIR", join(b, ".git"))
			// git symbolic-ref --short HEAD answers from $GIT_DIR; the direct .git walk must not win.
			const branch = await new Promise<string | undefined>((resolve) => refreshGitBranch(resolve, a))
			expect(branch).toBe("branch-bbb")
		} finally {
			vi.unstubAllEnvs()
			rmSync(a, { recursive: true, force: true })
			rmSync(b, { recursive: true, force: true })
		}
	})
})
