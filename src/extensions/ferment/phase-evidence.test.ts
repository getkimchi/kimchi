import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { gatherPhaseEvidence } from "./phase-evidence.js"

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "phase-evidence-"))
	const opts = { cwd: dir, stdio: "ignore" as const }
	execSync("git init", opts)
	execSync('git config user.email "test@example.com"', opts)
	execSync('git config user.name "Test"', opts)
	execSync("git config commit.gpgsign false", opts)
	writeFileSync(join(dir, "README.md"), "initial\n")
	execSync("git add README.md", opts)
	execSync('git commit -m "init"', opts)
	return dir
}

describe("gatherPhaseEvidence", () => {
	let repoDir: string

	beforeEach(() => {
		repoDir = makeRepo()
	})

	afterEach(() => {
		execSync(`rm -rf ${repoDir}`)
	})

	it("returns no-changes evidence when nothing has been modified since ref", () => {
		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("(no changes)")
		expect(ev.diffSnippet).toBe("")
	})

	it("captures file list and diff after edits", () => {
		writeFileSync(join(repoDir, "feature.ts"), "export const foo = 1\n")
		writeFileSync(join(repoDir, "README.md"), "updated\n")
		execSync("git add .", { cwd: repoDir, stdio: "ignore" })
		execSync('git commit -m "feature"', { cwd: repoDir, stdio: "ignore" })

		const ev = gatherPhaseEvidence("HEAD~1", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("feature.ts")
		expect(ev.filesChanged).toContain("README.md")
		expect(ev.diffSnippet).toContain("export const foo")
	})

	it("captures uncommitted working-tree changes against HEAD", () => {
		writeFileSync(join(repoDir, "wip.ts"), "// work in progress\n")
		// Without git add, --stat HEAD shouldn't see the new untracked file
		// but --stat alone (no ref) would. Since we always pass a ref, we test
		// the staged + committed-not-yet path: stage the file.
		execSync("git add wip.ts", { cwd: repoDir, stdio: "ignore" })

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("wip.ts")
	})

	it("returns unavailable when not in a git repository", () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "no-git-"))
		const ev = gatherPhaseEvidence("HEAD", nonGitDir)
		expect(ev.available).toBe(false)
	})

	it("truncates very long diffs", () => {
		// Generate a large diff
		const big = "a".repeat(10_000)
		writeFileSync(join(repoDir, "big.txt"), big)
		execSync("git add big.txt", { cwd: repoDir, stdio: "ignore" })
		execSync('git commit -m "big"', { cwd: repoDir, stdio: "ignore" })

		const ev = gatherPhaseEvidence("HEAD~1", repoDir)
		expect(ev.diffSnippet).toContain("[... diff truncated")
		expect(ev.diffSnippet.length).toBeLessThan(10_000)
	})
})
