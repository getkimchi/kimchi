import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, sendTerminalInput } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	acquireReviewOperation,
	cancelActiveReview,
	isReviewTerminalInputActive,
	registerPendingReview,
} from "./active-runs.js"
import { runReviewCommand } from "./command.js"
import reviewCommandExtension from "./index.js"
import { currentReviewHost, currentReviewOwnerIdentity } from "./owner-identity.js"
import { createLocalReviewRunDirectory } from "./run-directory.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function sandbox(): { root: string; outputRoot: string; checkoutPath: string } {
	const root = mkdtempSync(join(tmpdir(), "review-active-runs-"))
	temporaryDirectories.push(root)
	return { root, outputRoot: join(root, "review-output"), checkoutPath: root }
}

describe("active local review runs", () => {
	it("uses distinct directories, rejects concurrency, and releases its persistent lock after cleanup", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const firstDir = await createLocalReviewRunDirectory(outputRoot)
		const first = await acquireReviewOperation(ctx, checkoutPath, firstDir)
		expect(existsSync(join(outputRoot, "active-review.json"))).toBe(true)
		const competingDir = await createLocalReviewRunDirectory(outputRoot)
		expect(competingDir.runDir).not.toBe(firstDir.runDir)
		await expect(acquireReviewOperation(ctx, checkoutPath, competingDir)).rejects.toMatchObject({
			code: "review_in_progress",
		})
		await first.finish()
		await expect(first.completion).resolves.toBeUndefined()
		expect(existsSync(join(outputRoot, "active-review.json"))).toBe(false)
		const second = await acquireReviewOperation(ctx, checkoutPath, competingDir)
		await second.finish()
	})

	it("leaves no lock behind when owner identity lookup fails", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const ownerIdentity = async () => ({ hostname: currentReviewHost(), startIdentity: "test-owner" })

		await expect(
			acquireReviewOperation(ctx, checkoutPath, runDir, async () => {
				throw new Error("identity lookup failed")
			}),
		).rejects.toThrow("identity lookup failed")
		expect(existsSync(runDir.lockPath)).toBe(false)

		const retry = await acquireReviewOperation(ctx, checkoutPath, runDir, ownerIdentity)
		expect(existsSync(runDir.lockPath)).toBe(true)
		await retry.finish()
	})

	it("waits for active cleanup during session shutdown", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const { api, emit } = createExtensionApi()
		reviewCommandExtension(api)
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		const shutdown = emit("session_shutdown", {}, ctx)
		expect(operation.cancelled).toBe(true)
		await operation.finish()
		await expect(shutdown).resolves.toBeDefined()
	})

	it.each([
		["legacy Esc", "\u001b", Key.escape],
		["legacy Ctrl+C", "\u0003", Key.ctrl("c")],
		["Kitty Esc", "\u001b[27u", Key.escape],
		["Kitty Ctrl+C", "\u001b[99;5u", Key.ctrl("c")],
	])("aborts the active operation on %s terminal input", async (_name, sequence, key) => {
		expect(matchesKey(sequence, key)).toBe(true)
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		expect(isReviewTerminalInputActive(ctx.sessionManager.getSessionId())).toBe(true)
		sendTerminalInput(ctx, sequence)
		expect(operation.cancelled).toBe(true)
		await operation.finish()
		expect(isReviewTerminalInputActive(ctx.sessionManager.getSessionId())).toBe(false)
	})

	it("transfers terminal cancellation from pending setup to the active operation", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const pending = registerPendingReview(ctx)
		pending.captureInput()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir, undefined, pending.signal)
		pending.releaseInput()

		sendTerminalInput(ctx, "\u001b")
		expect(pending.signal.aborted).toBe(false)
		expect(operation.cancelled).toBe(true)
		await operation.finish()
		pending.finish()
	})

	it("reclaims PID reuse when the current process has a different start identity", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		writeFileSync(
			join(outputRoot, "active-review.json"),
			JSON.stringify({
				token: "reused-pid-owner",
				pid: process.pid,
				owner_host: currentReviewHost(),
				owner_start: "different-process-start",
				checkoutPath,
				runDir: runDir.runDir,
			}),
		)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		const current = JSON.parse(readFileSync(join(outputRoot, "active-review.json"), "utf8"))
		const owner = await currentReviewOwnerIdentity()
		expect(current.token).not.toBe("reused-pid-owner")
		expect(current).toMatchObject({
			pid: process.pid,
			owner_host: owner.hostname,
			owner_start: owner.startIdentity,
			runDir: runDir.runDir,
		})
		await operation.finish()
	})

	it("preserves another host's lock even when its PID cannot exist locally", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const lockPath = join(outputRoot, "active-review.json")
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "foreign-owner",
				pid: 2 ** 30,
				owner_host: "another-host.invalid",
				owner_start: "different-process-start",
				checkoutPath,
				runDir: runDir.runDir,
			}),
		)
		await expect(acquireReviewOperation(ctx, checkoutPath, runDir)).rejects.toThrow(
			/another host|remove only this file/,
		)
		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("foreign-owner")
	})

	it("blocks a live local lock whose host and process-start identity match", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const owner = await currentReviewOwnerIdentity()
		const lockPath = join(outputRoot, "active-review.json")
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "live-owner",
				pid: process.pid,
				owner_host: owner.hostname,
				owner_start: owner.startIdentity,
				checkoutPath,
				runDir: runDir.runDir,
			}),
		)
		await expect(acquireReviewOperation(ctx, checkoutPath, runDir)).rejects.toMatchObject({
			code: "review_in_progress",
		})
		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("live-owner")
	})

	it("reclaims a stale lock left by a dead process without deleting old run artifacts", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const oldArtifact = join(runDir.runDir, "summary.json")
		writeFileSync(oldArtifact, "{}")
		writeFileSync(
			join(outputRoot, "active-review.json"),
			JSON.stringify({
				token: "dead-owner",
				pid: 2 ** 30,
				owner_host: currentReviewHost(),
				owner_start: "dead-process-start",
				checkoutPath,
				runDir: runDir.runDir,
			}),
		)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		expect(existsSync(oldArtifact)).toBe(true)
		const current = JSON.parse(readFileSync(join(outputRoot, "active-review.json"), "utf8"))
		expect(current.token).not.toBe("dead-owner")
		await operation.finish()
		expect(existsSync(oldArtifact)).toBe(true)
	})

	it("allows exactly one winner when two acquirers reclaim the same stale lock", { timeout: 20_000 }, async () => {
		const { root } = sandbox()
		const owner = await currentReviewOwnerIdentity()
		const ownerIdentity = async () => owner
		for (let trial = 0; trial < 200; trial += 1) {
			const outputRoot = join(root, `race-${trial}`)
			const lockPath = join(outputRoot, "active-review.json")
			mkdirSync(join(outputRoot, "runs"), { recursive: true })
			writeFileSync(
				lockPath,
				JSON.stringify({
					token: "dead-owner",
					pid: 999_999,
					owner_host: currentReviewHost(),
					owner_start: "dead-process-start",
				}),
			)
			const operations: Awaited<ReturnType<typeof acquireReviewOperation>>[] = []
			const acquire = (id: string) => {
				const ctx = createCommandContext()
				ctx.sessionManager.getSessionId = () => `race-${trial}-${id}`
				return acquireReviewOperation(
					ctx,
					join(root, id),
					{ runDir: join(outputRoot, "runs", id), lockPath },
					ownerIdentity,
				).then(
					(operation) => {
						operations.push(operation)
						return "ok"
					},
					(error: unknown) => (error as { code?: string }).code,
				)
			}

			const results = await Promise.all([acquire("a"), acquire("b")])
			expect(results.sort()).toEqual(["ok", "review_in_progress"].sort())
			expect(operations).toHaveLength(1)
			await Promise.all(operations.map((operation) => operation.finish()))
			expect(readdirSync(outputRoot).sort()).toEqual(["runs"])
		}
	})

	it("honors cancellation that arrives while the target is still resolving", async () => {
		const { root } = sandbox()
		const ctx = createCommandContext()
		ctx.cwd = root
		const { api } = createExtensionApi()
		let finishResolve!: () => void
		const resolving = new Promise<void>((resolve) => {
			finishResolve = resolve
		})
		let targetSignal: AbortSignal | undefined
		const runPanel = vi.fn(async () => ({
			progress: { coverage: { status: "complete", unfinished_lenses: [] } },
			findings: [],
			summaryPath: "unused",
		}))
		const run = runReviewCommand("working-tree --lens spec", ctx, api, {
			dependencies: {
				cleanSnapshots: async () => [],
				recoverWorktrees: async () => [],
				readSettings: () => ({ requiredLenses: [], checkDefinitions: [] }) as never,
				resolveTarget: async (_request, options) => {
					targetSignal = options.signal
					await resolving
					return {
						scope: {
							kind: "working-tree",
							checkoutPath: root,
							files: { changed: 1 },
							pinned: { baseSha: "a", headSha: "b" },
						},
						cleanup: async () => {},
					} as never
				},
				resolvePanel: () => ({ lenses: [], slotCount: 1 }) as never,
				runPanel: runPanel as never,
			},
		})
		await vi.waitFor(() => expect(targetSignal).toBeDefined())

		await cancelActiveReview(ctx.sessionManager.getSessionId())
		finishResolve()
		await run

		expect(targetSignal?.aborted).toBe(true)
		expect(runPanel).not.toHaveBeenCalled()
	})
})
