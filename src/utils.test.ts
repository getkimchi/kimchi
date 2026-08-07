import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

function initRepo(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "kimchi-git-"))
	git(dir, ["init"])
	writeFileSync(resolve(dir, "file.txt"), "x")
	git(dir, ["add", "."])
	git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"])
	return dir
}

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

describe("getGitBranch", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	it("returns the branch name on a normal checkout", async () => {
		const dir = initRepo()
		const { getGitBranch } = await import("./utils.js")
		expect(getGitBranch(dir)).toMatch(/^(main|master)$/u)
	})

	it("falls back to the short HEAD sha with a (detached) label on detached HEAD", async () => {
		const dir = initRepo()
		git(dir, ["checkout", "--detach", "HEAD"])
		const { getGitBranch } = await import("./utils.js")
		const sha = git(dir, ["rev-parse", "--short", "HEAD"]).trim()
		expect(getGitBranch(dir)).toBe(`${sha} (detached)`)
	})

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(resolve(tmpdir(), "kimchi-nogit-"))
		const { getGitBranch } = await import("./utils.js")
		expect(getGitBranch(dir)).toBeUndefined()
	})
})
