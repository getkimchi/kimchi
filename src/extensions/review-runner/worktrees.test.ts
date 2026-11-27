import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reviewProcessStartIdentity } from "../review-command/owner-identity.js"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest, ResolvedReviewTarget } from "../review-targets/types.js"
import type { ReviewEnvironmentSettings } from "./environment.js"
import type { ReviewNetworkBoundary } from "./network-boundary.js"
import { createReviewWorktreePool, REVIEW_WORKTREE_TESTING, recoverReviewWorktrees } from "./worktrees.js"

const CRASH_FIXTURE = fileURLToPath(new URL("./worktrees-crash-fixture.ts", import.meta.url))
const testBoundary: ReviewNetworkBoundary = { kind: "sandbox-exec", wrap: (command) => command }

function environmentSettings(setup: ReviewEnvironmentSettings["profiles"]["default"]): ReviewEnvironmentSettings {
	return { caches: [], toolchains: [], profiles: { ...(setup ? { default: setup } : {}), repositories: {} } }
}

function profile(
	overrides: Partial<NonNullable<ReviewEnvironmentSettings["profiles"]["default"]>>,
): NonNullable<ReviewEnvironmentSettings["profiles"]["default"]> {
	return { readOnlyCaches: [], privateDirs: [], env: {}, setup: [], probes: [], ...overrides }
}

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

async function markManifestProcessExited(runDir: string): Promise<void> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject)
		child.once("spawn", resolve)
	})
	if (child.pid === undefined) throw new Error("PID fixture did not expose a process ID")
	const ownerStart = await reviewProcessStartIdentity(child.pid)
	const closed = new Promise<void>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", () => resolve())
	})
	child.kill("SIGKILL")
	await closed
	const manifestPath = join(runDir, REVIEW_WORKTREE_TESTING.MANIFEST)
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
	writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ownerPid: child.pid, ownerStart }, null, 2)}\n`)
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
		vi.restoreAllMocks()
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
		expect(first.gitAdminDir).toBe(realpathSync(resolve(first.path, git(first.path, "rev-parse", "--git-dir"))))
		const readyManifest = JSON.parse(readFileSync(join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST), "utf8")) as {
			worktrees: Array<{ path: string; gitAdminDir?: string }>
		}
		expect(readyManifest.worktrees.find((entry) => entry.path === first.path)?.gitAdminDir).toBe(first.gitAdminDir)
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

	it("persists independent ready base/head receipts before returning their worktrees", async () => {
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		const base = await pool.getWorktree("comparison", { kind: "reviewer", revision: "base" })
		const head = await pool.getWorktree("comparison", { kind: "reviewer", revision: "head" })
		expect(base.environment?.readiness).toBe("ready")
		expect(head.environment?.readiness).toBe("ready")
		expect(base.environment?.requestedSpecDigest).toBe(head.environment?.requestedSpecDigest)
		expect(base.environment?.receiptDigest).not.toBe(head.environment?.receiptDigest)
		const environmentsPath = join(outputDir, "state", "environments.json")
		const persisted = JSON.parse(readFileSync(environmentsPath, "utf8"))
		expect(persisted.schema_version).toBe("review-environments/v1")
		expect(persisted.environments).toHaveLength(2)
		expect(statSync(environmentsPath).mode & 0o777).toBe(0o600)
		const manifest = JSON.parse(readFileSync(join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST), "utf8"))
		expect(manifest.worktrees.map((entry: { status: string }) => entry.status)).toEqual(["ready", "ready"])
		await pool.cleanup()
	})

	it("cleans a failed optional setup before exposing a degraded isolated worktree", async () => {
		const setup: NonNullable<ReviewEnvironmentSettings["profiles"]["default"]> = {
			readOnlyCaches: [],
			privateDirs: [],
			env: {},
			setup: [
				{
					argv: [
						process.execPath,
						"-e",
						"const fs=require('node:fs');fs.writeFileSync('file.txt','partial');fs.writeFileSync(process.env.TMPDIR+'/partial','x');process.exit(7)",
					],
					cwd: ".",
					timeoutMs: 5_000,
					required: false,
				},
			],
			probes: [
				{ id: "not-run", argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutMs: 1000, required: true },
			],
		}
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			environment: environmentSettings(setup),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		const worktree = await pool.getWorktree("fallback")
		expect(worktree.environment?.readiness).toBe("degraded")
		expect(worktree.environment?.effectiveSpec.setup).toEqual([])
		expect(worktree.environment?.gaps.at(-1)).toMatchObject({ kind: "setup_failed" })
		expect(worktree.environment?.probes[0]?.status).toBe("skipped")
		expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("base\nhead\n")
		expect(existsSync(join(worktree.scratchDir, "partial"))).toBe(false)
		await pool.cleanup()
	})

	it("prepares two distinct worktrees concurrently", async () => {
		const starts = join(sandbox, "preparation-starts.log")
		const delay = 180
		const script = `const fs=require('node:fs');fs.appendFileSync(process.env.PREP_LOG,String(Date.now())+'\\n');setTimeout(()=>{},${delay})`
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			concurrency: 2,
			environment: environmentSettings(
				profile({
					env: { PREP_LOG: starts },
					setup: [{ argv: [process.execPath, "-e", script], cwd: ".", timeoutMs: 2_000, required: true }],
				}),
			),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		const [first, second] = await Promise.all([pool.getWorktree("parallel-one"), pool.getWorktree("parallel-two")])
		expect(first.environment?.readiness).toBe("ready")
		expect(second.environment?.readiness).toBe("ready")
		const observed = readFileSync(starts, "utf8").trim().split("\n").map(Number)
		expect(observed).toHaveLength(2)
		expect(Math.max(...observed) - Math.min(...observed)).toBeLessThan(delay)
		await pool.cleanup()
	})

	it.skipIf(process.platform === "win32")(
		"kills a detached setup daemon even when setup exits successfully",
		async () => {
			const pidPath = join(sandbox, "detached-success.pid")
			const childScript =
				"const fs=require('node:fs');setTimeout(()=>{try{fs.writeFileSync('file.txt','detached-write')}catch{}},350);setInterval(()=>{},1000)"
			const script = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref()`
			const pool = await createReviewWorktreePool({
				target: await branchTarget(),
				outputDir,
				rootDir,
				environment: environmentSettings(
					profile({ setup: [{ argv: [process.execPath, "-e", script], cwd: ".", timeoutMs: 2000, required: true }] }),
				),
				executionPolicy: { mode: "local", networkBoundary: testBoundary },
			})
			const worktree = await pool.getWorktree("detached-success")
			const childPid = Number(readFileSync(pidPath, "utf8"))
			const isAlive = () => {
				try {
					const state = execFileSync("ps", ["-p", String(childPid), "-o", "stat="], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}).trim()
					return state !== "" && !state.startsWith("Z")
				} catch {
					return false
				}
			}
			try {
				expect(worktree.environment?.readiness).toBe("ready")
				await new Promise((resolve) => setTimeout(resolve, 425))
				expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("base\nhead\n")
				await vi.waitFor(() => expect(isAlive()).toBe(false))
			} finally {
				try {
					process.kill(childPid, "SIGKILL")
				} catch {
					// Expected after successful containment.
				}
				await pool.cleanup()
			}
		},
	)

	it("terminates detached setup descendants and creates a fresh isolated worktree", async () => {
		const original = join(sandbox, "detach.out")
		const childScript =
			"const fs=require('node:fs');setTimeout(()=>{try{fs.writeFileSync('file.txt','detached-write')}catch{}},350);setInterval(()=>{},1000)"
		const script = `const fs=require('node:fs');const {spawn}=require('node:child_process');fs.writeFileSync(${JSON.stringify(original)},process.cwd());const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});child.unref();setTimeout(()=>{},10000)`
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			preparationTimeoutMs: 100,
			environment: environmentSettings(
				profile({ setup: [{ argv: [process.execPath, "-e", script], cwd: ".", timeoutMs: 2000, required: false }] }),
			),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		const worktree = await pool.getWorktree("detached-fallback")
		const originalPath = readFileSync(original, "utf8")
		expect(worktree.path).not.toBe(originalPath)
		expect(worktree.environment?.readiness).toBe("degraded")
		await new Promise((resolve) => setTimeout(resolve, 425))
		expect(existsSync(originalPath)).toBe(false)
		expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("base\nhead\n")
		await pool.cleanup()
	})

	it("cancels an individual lease during preparation without resolving it later", async () => {
		const started = join(sandbox, "individual-abort-started")
		const control = new AbortController()
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			environment: environmentSettings(
				profile({
					env: { STARTED_PATH: started },
					setup: [
						{
							argv: [
								process.execPath,
								"-e",
								"require('node:fs').writeFileSync(process.env.STARTED_PATH,'started');setTimeout(()=>{},500)",
							],
							cwd: ".",
							timeoutMs: 2000,
							required: false,
						},
					],
				}),
			),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		const pending = pool.leaseReviewer("individual-abort", { signal: control.signal })
		await vi.waitFor(() => expect(existsSync(started)).toBe(true))
		const abortedAt = Date.now()
		control.abort(new Error("individual lease stopped"))
		await expect(pending).rejects.toThrow("individual lease stopped")
		expect(Date.now() - abortedAt).toBeLessThan(300)
		await vi.waitFor(() => expect(pool.environmentReceipts[0]?.gaps.at(-1)?.kind).toBe("environment_aborted"))
		await pool.cleanup()
	})

	it("merges environment receipts across pools sharing one output directory", async () => {
		const target = await branchTarget()
		const first = await createReviewWorktreePool({ target, outputDir, rootDir })
		await first.getWorktree("shared-lens")
		await first.cleanup()
		const second = await createReviewWorktreePool({ target, outputDir, rootDir: join(sandbox, "resume-worktrees") })
		await second.getWorktree("resume-verifier", { kind: "verifier" })
		const state = JSON.parse(readFileSync(join(outputDir, "state", "environments.json"), "utf8"))
		expect(state.environments.map((receipt: { worktreeId: string }) => receipt.worktreeId)).toEqual([
			"reviewer:head:shared-lens",
			"verifier:head:resume-verifier",
		])
		await second.cleanup()
	})

	it("enforces an overall per-worktree preparation timeout", async () => {
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			preparationTimeoutMs: 75,
			environment: environmentSettings(
				profile({
					setup: [
						{ argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], cwd: ".", timeoutMs: 2_000, required: true },
						{ argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeoutMs: 100, required: true },
					],
				}),
			),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		await expect(pool.getWorktree("overall-timeout")).rejects.toThrow("unready")
		const receipt = pool.environmentReceipts[0]
		expect(receipt?.readiness).toBe("unready")
		expect(receipt?.setup.map((record) => record.status)).toEqual(["timeout", "skipped"])
		expect(receipt?.gaps.at(-1)).toMatchObject({ kind: "setup_failed" })
		await pool.cleanup()
	})

	it("rejects a tracked symlink as a setup cwd without executing outside", async () => {
		const outside = join(sandbox, "outside-command")
		mkdirSync(outside)
		symlinkSync(outside, join(repo, "escape"), "dir")
		git(repo, "add", "escape")
		git(repo, "commit", "-m", "tracked setup escape symlink")
		const pool = await createReviewWorktreePool({
			target: await branchTarget(),
			outputDir,
			rootDir,
			environment: environmentSettings(
				profile({
					setup: [
						{
							argv: [process.execPath, "-e", "require('node:fs').writeFileSync('escaped','bad')"],
							cwd: "escape",
							timeoutMs: 1000,
							required: true,
						},
					],
				}),
			),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
		})
		await expect(pool.getWorktree("symlink-cwd")).rejects.toThrow("unready")
		const receipt = pool.environmentReceipts[0]
		expect(receipt?.readiness).toBe("unready")
		expect(receipt?.setup[0]?.output).toContain("symbolic link")
		expect(existsSync(join(outside, "escaped"))).toBe(false)
		await pool.cleanup()
	})

	it("captures git admin paths when the repository path contains a newline", async () => {
		const newlineRepo = join(sandbox, "repo\nwith-newline")
		renameSync(repo, newlineRepo)
		repo = newlineRepo
		const pool = await createReviewWorktreePool({ target: await branchTarget(), outputDir, rootDir })
		const worktree = await pool.getWorktree("newline-repository")
		const expectedAdminDir = git(worktree.path, "rev-parse", "--path-format=absolute", "--git-dir")
		expect(worktree.gitAdminDir).toBe(realpathSync(expectedAdminDir))
		expect(worktree.gitAdminDir).toContain("\n")
		await pool.cleanup()
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
		await markManifestProcessExited(pool.runDir)
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

	it("reclaims dead manifest state after its repository is deleted", async () => {
		writeFileSync(join(repo, "file.txt"), "deleted repository\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const worktree = await pool.getWorktree("writer")
		await markManifestProcessExited(pool.runDir)
		const canonicalRepository = realpathSync(repo)
		rmSync(repo, { recursive: true, force: true })
		const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
		expect(recovered).toHaveLength(1)
		expect(recovered[0]).toMatchObject({ runDir: pool.runDir, repository: canonicalRepository })
		expect(existsSync(pool.runDir)).toBe(false)
		expect(existsSync(worktree.path)).toBe(false)
	})

	it("preserves worktrees and snapshot refs owned by another live process", async () => {
		writeFileSync(join(repo, "file.txt"), "other live review\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const worktree = await pool.getWorktree("writer")
		const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
		const holderPid = holder.pid
		if (holderPid === undefined) throw new Error("Live-holder process has no PID")
		try {
			const ownerStart = await reviewProcessStartIdentity(holderPid)
			const manifestPath = join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST)
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
			manifest.ownerPid = holderPid
			manifest.ownerStart = ownerStart
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
			await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 0 })).resolves.toEqual([])
			expect(existsSync(pool.runDir)).toBe(true)
			expect(existsSync(worktree.path)).toBe(true)
			expect(refExists(repo, target.scope.pinned.snapshotRef ?? "")).toBe(true)
		} finally {
			await pool.cleanup()
			holder.kill("SIGKILL")
			await new Promise<void>((resolve) => holder.once("close", () => resolve()))
		}
	})

	it("preserves live worktrees for a foreign or unknown owner during wrap-up", async () => {
		writeFileSync(join(repo, "file.txt"), "hostname changed\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const worktree = await pool.getWorktree("writer")
		const manifestPath = join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST)
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		try {
			manifest.ownerHost = "old-hostname.local"
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
			await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 0 })).resolves.toEqual([])
			expect(existsSync(worktree.path)).toBe(true)

			for (const key of ["ownerPid", "ownerHost", "ownerStart"]) delete manifest[key]
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
			await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 0 })).resolves.toEqual([])
			expect(existsSync(worktree.path)).toBe(true)
			expect(refExists(repo, target.scope.pinned.snapshotRef ?? "")).toBe(true)
		} finally {
			await pool.cleanup()
		}
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
		await markManifestProcessExited(pool.runDir)
		git(repo, "update-ref", snapshotRef, baseSha)
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 0 })).resolves.toEqual([])
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("no longer points"))
		expect(existsSync(join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST))).toBe(true)
		expect(refExists(repo, snapshotRef)).toBe(true)

		git(repo, "update-ref", snapshotRef, target.scope.pinned.headSha)
		const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
		expect(recovered).toHaveLength(1)
		expect(recovered[0]?.removedWorktrees).toContain(worktree.path)
		expect(existsSync(pool.runDir)).toBe(false)
		expect(refExists(repo, snapshotRef)).toBe(false)
	})

	it("settles a lease when cleanup races checkout creation", async () => {
		const pool = await createReviewWorktreePool({ target: await branchTarget(), outputDir, rootDir })
		const lease = pool.leaseReviewer("racing-reviewer")
		const outcome = lease.then(
			() => "resolved",
			() => "rejected",
		)
		await pool.cleanup()
		const settled = await Promise.race([
			outcome,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
		])
		expect(settled).toBe("rejected")
	})

	it("continues recovery past a corrupt manifest", async () => {
		const pool = await createReviewWorktreePool({ target: await branchTarget(), outputDir, rootDir })
		const worktree = await pool.getWorktree("recoverable")
		await markManifestProcessExited(pool.runDir)
		const broken = join(rootDir, "aaa-broken")
		mkdirSync(broken, { recursive: true })
		writeFileSync(join(broken, REVIEW_WORKTREE_TESTING.MANIFEST), "")
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const recovered = await recoverReviewWorktrees({ rootDir, olderThanMs: 0 })
			expect(recovered.map((run) => run.runDir)).toEqual([pool.runDir])
			expect(existsSync(worktree.path)).toBe(false)
			expect(warning).toHaveBeenCalledWith(expect.stringContaining(broken))
		} finally {
			rmSync(broken, { recursive: true, force: true })
		}
	})

	it("does not reclaim an old manifest while its process is alive", async () => {
		writeFileSync(join(repo, "file.txt"), "live working tree\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const snapshotRef = target.scope.pinned.snapshotRef ?? ""
		const pool = await createReviewWorktreePool({ target, outputDir, rootDir })
		const lease = await pool.leaseReviewer("live-reviewer")
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
		utimesSync(join(pool.runDir, REVIEW_WORKTREE_TESTING.MANIFEST), old, old)
		try {
			await expect(recoverReviewWorktrees({ rootDir, olderThanMs: 60 * 60 * 1000 })).resolves.toEqual([])
			expect(existsSync(lease.worktree.path)).toBe(true)
			expect(refExists(repo, snapshotRef)).toBe(true)
		} finally {
			lease.release()
			await pool.cleanup().catch(() => {})
		}
	})

	it("releases the target when pool creation fails before manifest setup", async () => {
		writeFileSync(join(repo, "file.txt"), "uncommitted working tree\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir,
		})
		const snapshotRef = target.scope.pinned.snapshotRef ?? ""
		expect(snapshotRef).not.toBe("")
		try {
			await expect(createReviewWorktreePool({ target, outputDir, rootDir: join(repo, "nested") })).rejects.toThrow(
				"must be separate from the checkout",
			)
			expect(refExists(repo, snapshotRef)).toBe(false)
		} finally {
			await target.cleanup()
		}
	})
})
