import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
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
		// Modified tracked file (staged)
		writeFileSync(join(repoDir, "README.md"), "updated\n")
		execSync("git add README.md", { cwd: repoDir, stdio: "ignore" })

		// New untracked file (NOT staged)
		writeFileSync(join(repoDir, "wip.ts"), "// work in progress\n")

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("README.md")
		expect(ev.filesChanged).toContain("?? wip.ts")
		expect(ev.diffSnippet).toContain("// work in progress")
	})

	it("captures untracked new files even when no tracked files changed", () => {
		writeFileSync(join(repoDir, "new-feature.ts"), "export const foo = 42\n")

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("?? new-feature.ts")
		expect(ev.diffSnippet).toContain("export const foo")
		expect(ev.diffSnippet).toContain("+export const foo = 42")
	})

	it("captures multiple untracked files in the file list and diff", () => {
		writeFileSync(join(repoDir, "a.ts"), "export const a = 1\n")
		writeFileSync(join(repoDir, "b.ts"), "export const b = 2\n")

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.filesChanged).toContain("?? a.ts")
		expect(ev.filesChanged).toContain("?? b.ts")
		expect(ev.diffSnippet).toContain("export const a")
		expect(ev.diffSnippet).toContain("export const b")
	})

	it("does not capture gitignored untracked files", () => {
		writeFileSync(join(repoDir, ".gitignore"), "*.log\n")
		execSync("git add .gitignore", { cwd: repoDir, stdio: "ignore" })
		execSync('git commit -m "add gitignore"', { cwd: repoDir, stdio: "ignore" })

		writeFileSync(join(repoDir, "ignored.log"), "log entry\n")
		writeFileSync(join(repoDir, "real.ts"), "export const x = 1\n")

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.filesChanged).not.toContain("ignored.log")
		expect(ev.filesChanged).toContain("?? real.ts")
	})

	it("handles untracked file names with shell metacharacters safely", () => {
		// Regression test for command injection: file names with shell
		// metacharacters must not break out of the git command. If the
		// filename is shell-interpreted, `;touch marker` creates a file
		// named `marker` in repoDir. With spawnSync (shell: false) it is
		// treated as a literal filename.
		const trickyName = "file;touch marker"
		writeFileSync(join(repoDir, trickyName), "export const safe = true\n")

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		expect(ev.diffSnippet).toContain("export const safe")
		// The injection must not have created the marker file
		expect(existsSync(join(repoDir, "marker"))).toBe(false)
	})

	it("caps untracked entries independently so they do not crowd out tracked files", () => {
		// Create a tracked change
		writeFileSync(join(repoDir, "README.md"), "updated\n")
		execSync("git add README.md", { cwd: repoDir, stdio: "ignore" })

		// Create many untracked files (more than MAX_FILES_LISTED)
		for (let i = 0; i < 25; i++) {
			writeFileSync(join(repoDir, `untracked-${i}.ts`), `export const v${i} = ${i}\n`)
		}

		const ev = gatherPhaseEvidence("HEAD", repoDir)
		expect(ev.available).toBe(true)
		// Tracked file must still appear despite many untracked files
		expect(ev.filesChanged).toContain("README.md")
		// Untracked files should be present but capped
		expect(ev.filesChanged).toContain("?? untracked-0.ts")
		expect(ev.filesChanged).toContain("more untracked files")
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
