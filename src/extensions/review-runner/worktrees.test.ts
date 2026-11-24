import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest, ResolvedReviewTarget } from "../review-targets/types.js"
import { createReviewWorktreePool, REVIEW_WORKTREE_TESTING, recoverReviewWorktrees } from "./worktrees.js"

const CRASH_FIXTURE = fileURLToPath(new URL("./worktrees-crash-fixture.ts", import.meta.url))

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function refExists(root: string, ref: string): boolean {
	try {
		git(root, "rev-parse", "--verify", ref)
		return true
	} catch {
		return false
	}
}

function checkoutState(root: string) {
	return {
		head: git(root, "rev-parse", "HEAD"),
		branch: git(root, "symbolic-ref", "HEAD"),
		index: createHash("sha256")
			.update(readFileSync(git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")))
			.digest("hex"),
		status: git(root, "status", "--porcelain=v2", "--untracked-files=all"),
		stash: git(root, "stash", "list", "--format=%H"),
	}
}

describe("review worktree lifecycle", () => {
	let sandbox: string
	let repo: string
	let contextDir: string
	let outputDir: string
	let rootDir: string
	let baseSha: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-worktrees-test-"))
		repo = join(sandbox, "repo")
		contextDir = join(sandbox, "review-context")
		outputDir = join(sandbox, "review-output")
		rootDir = join(sandbox, "worktrees")
		mkdirSync(repo)
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Reviewer Test")
		git(repo, "config", "user.email", "review@localhost")
		writeFileSync(join(repo, "file.txt"), "base\n")
		git(repo, "add", "file.txt")
		git(repo, "commit", "-m", "base")
		baseSha = git(repo, "rev-parse", "HEAD")
		writeFileSync(join(repo, "file.txt"), "base\nhead\n")
		git(repo, "add", "file.txt")
		git(repo, "commit", "-m", "head")
		writeFileSync(join(repo, "stash.txt"), "stash base\n")
		git(repo, "add", "stash.txt")
		git(repo, "stash", "push", "-m", "preserve")
	})

	afterEach(async () => {
		await recoverReviewWorktrees({ rootDir, olderThanMs: 0 }).catch(() => {})
		rmSync(sandbox, { recursive: true, force: true })
	})

	async function branchTarget(): Promise<ResolvedReviewTarget> {
		return resolveReviewTarget(parseReviewTargetArgs(["branch", "main", "--base", baseSha]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
	}

	it("isolates same-path edits, runs no checkout hook, and bounds leases", async () => {
		const hookMarker = join(sandbox, "post-checkout-ran")
		mkdirSync(join(repo, ".githooks"))
		writeFileSync(join(repo, ".githooks", "post-checkout"), `#!/bin/sh\nprintf ran > ${hookMarker}\n`)
		execFileSync("chmod", ["+x", join(repo, ".githooks", "post-checkout")])
		git(repo, "config", "core.hooksPath", ".githooks")
		const target = await branchTarget()
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir, concurrency: 1 })
		const before = checkoutState(repo)
		const [first, second] = await Promise.all([pool.getWorktree("one"), pool.getWorktree("two")])
		expect(first.path).not.toBe(second.path)
		expect(first.path.startsWith(repo)).toBe(false)
		expect(first.scratchDir.startsWith(first.path)).toBe(false)
		expect(first.env.TMPDIR).toBe(first.scratchDir)
		expect(first.env.CARGO_TARGET_DIR.startsWith(first.buildDir)).toBe(true)
		expect(git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
		expect(git(first.path, "rev-parse", "HEAD")).toBe(target.scope.pinned.headSha)
		expect(existsSync(hookMarker)).toBe(false)

		writeFileSync(join(first.path, "focused.test"), "one")
		writeFileSync(join(second.path, "focused.test"), "two")
		expect(readFileSync(join(first.path, "focused.test"), "utf8")).toBe("one")
		expect(readFileSync(join(second.path, "focused.test"), "utf8")).toBe("two")

		const lease = await pool.leaseReviewer("one")
		const queued = pool.leaseReviewer("two")
		let acquired = false
		void queued.then(() => {
			acquired = true
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(acquired).toBe(false)
		lease.release()
		const secondLease = await queued
		secondLease.release()
		expect(acquired).toBe(true)
		expect(checkoutState(repo)).toEqual(before)
		await pool.cleanup()
		expect(checkoutState(repo)).toEqual(before)
	})

	it("removes worktrees before the snapshot ref and makes cleanup idempotent", async () => {
		writeFileSync(join(repo, "file.txt"), "working tree\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		let releaseCalls = 0
		const pool = await createReviewWorktreePool({
			target: {
				...target,
				cleanup: async () => {
					releaseCalls++
					for (const entry of [first, check]) {
						expect(existsSync(entry.path)).toBe(false)
						expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(entry.path)
					}
					await target.cleanup()
				},
			},
			outputDir,
			rootDir,
		})
		const first = await pool.getWorktree("writer")
		const check = await pool.getWorktree("routine-head", { kind: "checks" })
		expect(target.scope.pinned.snapshotRef).toBeDefined()
		await Promise.all([pool.cleanup(), pool.cleanup()])
		expect(releaseCalls).toBe(1)
		expect(existsSync(pool.runDir)).toBe(false)
		expect(refExists(repo, target.scope.pinned.snapshotRef ?? "")).toBe(false)
		expect(checkoutState(repo).stash).not.toBe("")
	})

	it("recovers a crashed run and releases its snapshot after the old worktree", async () => {
		writeFileSync(join(repo, "file.txt"), "interrupted working tree\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const worktree = await pool.getWorktree("crashed")
		const snapshotRef = target.scope.pinned.snapshotRef
		expect(snapshotRef).toBeDefined()
		const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
		expect(recovered).toHaveLength(1)
		expect(recovered[0]).toMatchObject({
			runDir: pool.runDir,
			removedWorktrees: [worktree.path],
			releasedSnapshotRef: snapshotRef,
		})
		expect(existsSync(worktree.path)).toBe(false)
		expect(existsSync(pool.runDir)).toBe(false)
		expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktree.path)
		expect(refExists(repo, snapshotRef ?? "")).toBe(false)
	})

	it.each(["before-add", "after-add"] as const)("recovers a real crash %s registration", async (point) => {
		writeFileSync(join(repo, "file.txt"), `crash ${point}\n`)
		const child = spawn(process.execPath, ["--import", "tsx", CRASH_FIXTURE], {
			env: {
				...process.env,
				REVIEW_CRASH_REPOSITORY: repo,
				REVIEW_CRASH_OUTPUT: outputDir,
				REVIEW_CRASH_ROOT: rootDir,
				REVIEW_CRASH_CONTEXT: contextDir,
				REVIEW_CRASH_POINT: point,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		})
		let stderr = ""
		child.stderr?.setEncoding("utf8").on("data", (chunk) => {
			stderr = `${stderr}${chunk}`.slice(-8192)
		})
		const interrupted = await new Promise<{ path: string; runDir: string }>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`crash fixture timed out: ${stderr}`)), 20_000)
			child.once("message", (message: { path: string; runDir: string }) => {
				clearTimeout(timeout)
				resolve(message)
			})
			child.once("error", (error) => {
				clearTimeout(timeout)
				reject(error)
			})
			child.once("exit", (code) => {
				clearTimeout(timeout)
				reject(new Error(`crash fixture exited early (${code}): ${stderr}`))
			})
		})
		child.kill("SIGKILL")
		await new Promise<void>((resolve) => child.once("close", () => resolve()))
		const manifest = JSON.parse(readFileSync(join(interrupted.runDir, REVIEW_WORKTREE_TESTING.MANIFEST), "utf8")) as {
			worktrees: Array<{ path: string; status: string }>
		}
		expect(manifest.worktrees).toEqual([expect.objectContaining({ path: interrupted.path, status: "pending" })])
		const registrations = git(repo, "worktree", "list", "--porcelain")
		expect(registrations.includes(interrupted.path)).toBe(point === "after-add")
		const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
		expect(recovered).toHaveLength(1)
		expect(recovered[0]?.removedWorktrees).toContain(interrupted.path)
		expect(existsSync(interrupted.runDir)).toBe(false)
		expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(interrupted.path)
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/kimchi/review/snapshots/")).toBe("")
	}, 30_000)

	it("keeps the crash manifest when snapshot cleanup fails so recovery can retry", async () => {
		writeFileSync(join(repo, "file.txt"), "ref cleanup interruption\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const worktree = await pool.getWorktree("interrupted")
		const snapshotRef = target.scope.pinned.snapshotRef
		if (!snapshotRef) throw new Error("expected a snapshot ref")
		git(repo, "update-ref", snapshotRef, baseSha)
		await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 0 })).rejects.toThrow("no longer points")
		expect(existsSync(join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST))).toBe(true)
		expect(refExists(repo, snapshotRef)).toBe(true)

		git(repo, "update-ref", snapshotRef, target.scope.pinned.headSha)
		const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
		expect(recovered).toHaveLength(1)
		expect(recovered[0]?.removedWorktrees).toContain(worktree.path)
		expect(existsSync(pool.runDir)).toBe(false)
		expect(refExists(repo, snapshotRef)).toBe(false)
	})
})
