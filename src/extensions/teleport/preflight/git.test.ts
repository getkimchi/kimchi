import { execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type GitPreflightOptions, getGitRemoteUrl, gitWorkingTreeDirty, isGitRepo } from "./git.js"

type MockExec = NonNullable<GitPreflightOptions["execFile"]>

function mockExec(fn: (file: string, args: readonly string[]) => string): MockExec {
	return ((file: string, args: readonly string[]) => fn(file, args)) as unknown as MockExec
}

function mockExecThrowing(): MockExec {
	return (() => {
		throw new Error("not a git repository")
	}) as unknown as MockExec
}

describe("isGitRepo", () => {
	it("returns true when .git exists", () => {
		const tmp = mkdtempSync(join(tmpdir(), "preflight-git-"))
		try {
			execSync("git init", { cwd: tmp, stdio: "ignore" })
			expect(isGitRepo(tmp)).toBe(true)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("returns false when .git is missing", () => {
		const tmp = mkdtempSync(join(tmpdir(), "preflight-norepo-"))
		try {
			expect(isGitRepo(tmp)).toBe(false)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})
})

describe("gitWorkingTreeDirty", () => {
	it("returns true when status --porcelain emits any output", () => {
		const exec = mockExec(() => " M src/foo.ts\n")
		expect(gitWorkingTreeDirty("/fake", { execFile: exec })).toBe(true)
	})

	it("returns false when status --porcelain is empty", () => {
		const exec = mockExec(() => "")
		expect(gitWorkingTreeDirty("/fake", { execFile: exec })).toBe(false)
	})

	it("returns false when only whitespace is emitted", () => {
		const exec = mockExec(() => "   \n")
		expect(gitWorkingTreeDirty("/fake", { execFile: exec })).toBe(false)
	})

	it("returns false when git exits non-zero (not a repo)", () => {
		expect(gitWorkingTreeDirty("/fake", { execFile: mockExecThrowing() })).toBe(false)
	})
})

describe("getGitRemoteUrl", () => {
	it("returns the URL, trimmed", () => {
		const exec = mockExec(() => "https://github.com/org/repo.git\n")
		expect(getGitRemoteUrl("/fake", { execFile: exec })).toBe("https://github.com/org/repo.git")
	})

	it("returns SSH shorthand URLs verbatim", () => {
		const exec = mockExec(() => "git@github.com:org/repo.git\n")
		expect(getGitRemoteUrl("/fake", { execFile: exec })).toBe("git@github.com:org/repo.git")
	})

	it("returns undefined when git exits non-zero", () => {
		expect(getGitRemoteUrl("/fake", { execFile: mockExecThrowing() })).toBeUndefined()
	})

	it("returns undefined when stdout is empty", () => {
		const exec = mockExec(() => "")
		expect(getGitRemoteUrl("/fake", { execFile: exec })).toBeUndefined()
	})

	it("invokes git with -C <cwd> remote get-url origin", () => {
		let receivedFile = ""
		let receivedArgs: readonly string[] = []
		const exec = mockExec((file, args) => {
			receivedFile = file
			receivedArgs = args
			return "https://example.com/repo.git"
		})
		getGitRemoteUrl("/work/dir", { execFile: exec })
		expect(receivedFile).toBe("git")
		expect(receivedArgs).toEqual(["-C", "/work/dir", "remote", "get-url", "origin"])
	})
})
