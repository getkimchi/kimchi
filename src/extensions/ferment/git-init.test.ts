import { execSync } from "node:child_process"
import { mkdtempSync, rmdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { autoInitFromEnv, ensureGitRepo } from "./git-init.js"
import type { FermentUi } from "./ui.js"

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "git-init-test-"))
	execSync("git init", { cwd: dir, stdio: "ignore" })
	execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" })
	execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" })
	execSync("git config commit.gpgsign false", { cwd: dir, stdio: "ignore" })
	return dir
}

function makeEmptyDir(): string {
	return mkdtempSync(join(tmpdir(), "git-init-test-empty-"))
}

function cleanup(dir: string): void {
	try {
		rmdirSync(dir, { recursive: true })
	} catch {
		// ignore cleanup errors
	}
}

function makeMockUi(confirmResult = false): FermentUi {
	return {
		notify: (_message: string) => {},
		confirm: async () => confirmResult,
	}
}

describe("ensureGitRepo", () => {
	let repos: string[]

	beforeEach(() => {
		repos = []
	})

	afterEach(() => {
		for (const dir of repos) {
			cleanup(dir)
		}
	})

	it("returns already-repo when cwd is the git root", async () => {
		const dir = makeGitRepo()
		repos.push(dir)
		const result = await ensureGitRepo({ cwd: dir })
		expect(result).toBe("already-repo")
	})

	it("returns already-repo when cwd is a subdirectory of a git repo", async () => {
		const dir = makeGitRepo()
		repos.push(dir)
		const subdir = join(dir, "subdir")
		execSync("mkdir subdir", { cwd: dir, stdio: "ignore" })

		const result = await ensureGitRepo({ cwd: subdir })
		expect(result).toBe("already-repo")
	})

	it("returns skipped when not in a git repo and no UI is provided", async () => {
		const dir = makeEmptyDir()
		repos.push(dir)
		const result = await ensureGitRepo({ cwd: dir })
		expect(result).toBe("skipped")
	})

	it("initializes a new repo when autoInit is true and not in a git repo", async () => {
		const dir = makeEmptyDir()
		repos.push(dir)
		const result = await ensureGitRepo({ cwd: dir, autoInit: true })
		expect(result).toBe("initialized")
	})

	it("returns already-repo when autoInit is true and inside a git repo", async () => {
		const dir = makeGitRepo()
		repos.push(dir)
		const result = await ensureGitRepo({ cwd: dir, autoInit: true })
		expect(result).toBe("already-repo")
	})

	it("returns declined when user declines the prompt", async () => {
		const dir = makeEmptyDir()
		repos.push(dir)
		const mockUi = makeMockUi()
		mockUi.confirm = async () => false

		const result = await ensureGitRepo({ cwd: dir, ui: mockUi })
		expect(result).toBe("declined")
	})

	it("returns initialized when user confirms the prompt", async () => {
		const dir = makeEmptyDir()
		repos.push(dir)
		const mockUi = makeMockUi(true)

		const result = await ensureGitRepo({ cwd: dir, ui: mockUi })
		expect(result).toBe("initialized")
	})

	it("returns init-failed when git init fails on a non-existent path", async () => {
		// Use a path to a non-existent directory so git init fails
		const dir = mkdtempSync(join(tmpdir(), "git-init-fail-"))
		repos.push(dir)
		const nonexistent = join(dir, "nonexistent", "path")
		const mockUi = makeMockUi(true) // confirm to trigger git init

		// git init on a path that doesn't exist should fail
		const result = await ensureGitRepo({ cwd: nonexistent, ui: mockUi })

		expect(result).toBe("init-failed")
	})
})

describe("autoInitFromEnv", () => {
	const originalVal = process.env.KIMCHI_AUTO_GIT_INIT

	afterEach(() => {
		if (originalVal === undefined) {
			process.env.KIMCHI_AUTO_GIT_INIT = undefined
		} else {
			process.env.KIMCHI_AUTO_GIT_INIT = originalVal
		}
	})

	it("returns false when KIMCHI_AUTO_GIT_INIT is not set", () => {
		process.env.KIMCHI_AUTO_GIT_INIT = undefined
		expect(autoInitFromEnv()).toBe(false)
	})

	it("returns true when KIMCHI_AUTO_GIT_INIT is '1'", () => {
		process.env.KIMCHI_AUTO_GIT_INIT = "1"
		expect(autoInitFromEnv()).toBe(true)
	})

	it("returns false when KIMCHI_AUTO_GIT_INIT is not '1'", () => {
		process.env.KIMCHI_AUTO_GIT_INIT = "yes"
		expect(autoInitFromEnv()).toBe(false)
	})
})
