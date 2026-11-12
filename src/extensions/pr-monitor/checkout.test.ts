import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkoutProblem } from "./checkout.js"
import type { PRSnapshot } from "./types.js"

describe("auto-fix checkout guard", () => {
	let cwd: string
	let pr: PRSnapshot
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "kimchi-pr-checkout-"))
		git("init", "-b", "feature")
		git("config", "user.name", "PR fixture")
		git("config", "user.email", "fixture@example.invalid")
		git("config", "commit.gpgSign", "false")
		writeFileSync(join(cwd, "hello.txt"), "hello\n")
		git("add", "hello.txt")
		git("commit", "-m", "fixture")
		pr = {
			provider: "github",
			repository: "owner/repo",
			number: 1,
			title: "Fixture",
			url: "https://github.com/owner/repo/pull/1",
			branch: "feature",
			headSha: git("rev-parse", "HEAD"),
			state: "open",
			checks: [],
			feedback: [],
		}
	})
	afterEach(() => rmSync(cwd, { recursive: true, force: true }))
	const signal = () => new AbortController().signal
	it("allows only a clean checkout of the exact remote head", async () => {
		expect(await checkoutProblem(cwd, pr, signal())).toBeNull()
	})
	it("refuses tracked and untracked local changes", async () => {
		writeFileSync(join(cwd, "hello.txt"), "user's unfinished work\n")
		expect(await checkoutProblem(cwd, pr, signal())).toContain("local changes")
		git("checkout", "--", "hello.txt")
		writeFileSync(join(cwd, "untracked.txt"), "unfinished\n")
		expect(await checkoutProblem(cwd, pr, signal())).toContain("local changes")
	})
	it("refuses a different branch even when it has the same commit", async () => {
		git("switch", "-c", "other")
		expect(await checkoutProblem(cwd, pr, signal())).toContain("branch changed")
	})
	it("refuses unpublished local commits and detached heads", async () => {
		expect(await checkoutProblem(cwd, { ...pr, headSha: "0".repeat(40) }, signal())).toContain("differs")
		git("checkout", "--detach")
		expect(await checkoutProblem(cwd, pr, signal())).toContain("branch changed")
	})
})
