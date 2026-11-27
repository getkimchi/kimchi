import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverPackageReviewChecks } from "./check-config.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function write(root: string, path: string, contents: string): void {
	const destination = join(root, path)
	mkdirSync(dirname(destination), { recursive: true })
	writeFileSync(destination, contents)
}

describe("reviewed-tree package check discovery", () => {
	let root: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-check-config-test-"))
		git(root, "init", "--initial-branch=main")
		git(root, "config", "user.name", "Reviewer Test")
		git(root, "config", "user.email", "review@localhost")
	})

	afterEach(() => rmSync(root, { recursive: true, force: true }))

	it("discovers package routines from the pinned tree, not later working-tree edits", async () => {
		write(root, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }))
		write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
		git(root, "add", "--all")
		git(root, "commit", "-m", "package routines")
		const sha = git(root, "rev-parse", "HEAD")
		write(root, "package.json", JSON.stringify({ scripts: {} }))
		expect(await discoverPackageReviewChecks(root, sha)).toMatchObject([
			{ id: "build", kind: "build", command: "pnpm run build", builds: false },
			{ id: "test", kind: "test", command: "pnpm run test", builds: false },
		])
	})

	it("never derives builds from a pretest substring or lifecycle implication", async () => {
		write(
			root,
			"package.json",
			JSON.stringify({ scripts: { build: "tsc", pretest: "echo skip build", test: "node --test" } }),
		)
		write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
		git(root, "add", "--all")
		git(root, "commit", "-m", "pretest is not evidence")
		const checks = await discoverPackageReviewChecks(root, git(root, "rev-parse", "HEAD"))
		expect(checks.find((check) => check.id === "test")?.builds).toBe(false)
	})

	it("recognizes only an exact build-then-test script", async () => {
		write(root, "package.json", JSON.stringify({ scripts: { test: "pnpm run build && node --test" } }))
		write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
		git(root, "add", "--all")
		git(root, "commit", "-m", "exact build then test")
		const checks = await discoverPackageReviewChecks(root, git(root, "rev-parse", "HEAD"))
		expect(checks.find((check) => check.id === "test")?.builds).toBe(true)
	})

	it("ignores a reviewed-head .kimchi/review-checks.json policy file", async () => {
		write(
			root,
			".kimchi/review-checks.json",
			JSON.stringify({ schema_version: "review-checks/v1", checks: [{ id: "test", command: "true", builds: true }] }),
		)
		git(root, "add", "--all")
		git(root, "commit", "-m", "untrusted policy file")
		expect(await discoverPackageReviewChecks(root, git(root, "rev-parse", "HEAD"))).toEqual([])
	})
})
