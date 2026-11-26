import { randomUUID } from "node:crypto"
import { link, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui"
import { lock as acquireDirectoryLock } from "proper-lockfile"
import { ReviewTargetError } from "../review-targets/types.js"
import { currentReviewHost, currentReviewOwnerIdentity, reviewProcessStartIdentity } from "./owner-identity.js"
import type { LocalReviewRunDirectory } from "./run-directory.js"

interface ActiveReview {
	checkoutPath: string
	controller: AbortController
	completion: Promise<void>
	complete: () => void
	detachInput?: () => void
	lockPath?: string
	lockToken?: string
}

const activeBySession = new Map<string, ActiveReview>()
const activeByCheckout = new Map<string, ActiveReview>()
const pendingBySession = new Map<string, { controller: AbortController; finish: () => void }>()
const terminalInputBySession = new Map<string, number>()

export function isReviewTerminalInputActive(sessionId: string): boolean {
	return (terminalInputBySession.get(sessionId) ?? 0) > 0
}

export interface ReviewOperation {
	signal: AbortSignal
	readonly runDir: string
	readonly cancelled: boolean
	readonly completion: Promise<void>
	finish: () => Promise<void>
}

function captureTerminalCancellation(ctx: ExtensionCommandContext, controller: AbortController): () => void {
	if (!ctx.hasUI) return () => {}
	const sessionId = ctx.sessionManager.getSessionId()
	terminalInputBySession.set(sessionId, (terminalInputBySession.get(sessionId) ?? 0) + 1)
	const detach = ctx.ui.onTerminalInput((data) => {
		if (isKeyRelease(data) || (!matchesKey(data, Key.escape) && !matchesKey(data, Key.ctrl("c")))) {
			return undefined
		}
		if (!controller.signal.aborted) controller.abort(new Error("Review interrupted by the user."))
		return { consume: true }
	})
	let released = false
	return () => {
		if (released) return
		released = true
		detach()
		const listeners = (terminalInputBySession.get(sessionId) ?? 1) - 1
		if (listeners > 0) terminalInputBySession.set(sessionId, listeners)
		else terminalInputBySession.delete(sessionId)
	}
}

export interface PendingReviewOperation {
	signal: AbortSignal
	captureInput: () => void
	releaseInput: () => void
	finish: () => void
}

/** Register before any asynchronous setup so ACP cancellation is never lost. */
export function registerPendingReview(ctx: ExtensionCommandContext): PendingReviewOperation {
	const sessionId = ctx.sessionManager.getSessionId()
	if (activeBySession.has(sessionId) || pendingBySession.has(sessionId)) throw activeError(ctx.cwd)
	const controller = new AbortController()
	let detachInput: (() => void) | undefined
	let finished = false
	const releaseInput = () => {
		detachInput?.()
		detachInput = undefined
	}
	const finish = () => {
		if (finished) return
		finished = true
		if (pendingBySession.get(sessionId)?.controller === controller) pendingBySession.delete(sessionId)
		releaseInput()
	}
	pendingBySession.set(sessionId, { controller, finish })
	return {
		signal: controller.signal,
		captureInput: () => {
			if (finished || detachInput || !ctx.hasUI) return
			detachInput = captureTerminalCancellation(ctx, controller)
		},
		releaseInput,
		finish,
	}
}

function activeError(checkoutPath: string): ReviewTargetError {
	return new ReviewTargetError(
		"review_in_progress",
		`A review is already running for ${checkoutPath}. Wait for it to finish or interrupt it before starting another review.`,
	)
}

async function processAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
		return true
	}
}

/** Serialize the whole stale-read/reclaim/publish transaction. No acquirer can
 * quarantine another acquirer's freshly published lock while it is delayed. */
async function withReclaimGuard<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const release = await acquireDirectoryLock(`${path}.reclaim`, {
		realpath: false,
		stale: 2_000,
		update: 1_000,
		retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 50 },
	})
	try {
		return await operation()
	} finally {
		await release()
	}
}

async function acquirePersistentLock(
	checkoutPath: string,
	run: LocalReviewRunDirectory,
	ownerIdentity: typeof currentReviewOwnerIdentity,
): Promise<{ path: string; token: string } | undefined> {
	const path = run.lockPath
	// Identity can require an external process. Never create even an empty lock
	// until that lookup has succeeded.
	const owner = await ownerIdentity()
	return withReclaimGuard(path, async () => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const token = randomUUID()
			const temporary = `${path}.${process.pid}.${token}.tmp`
			try {
				await mkdir(dirname(path), { recursive: true })
				const handle = await open(temporary, "wx", 0o600)
				try {
					await handle.writeFile(
						`${JSON.stringify({ token, pid: process.pid, checkoutPath, runDir: run.runDir, owner_host: owner.hostname, owner_start: owner.startIdentity })}\n`,
						"utf8",
					)
					await handle.sync()
				} finally {
					await handle.close()
				}
				// A hard link publishes only complete contents and atomically loses to
				// any existing owner without truncating or replacing its lock.
				await link(temporary, path)
				return { path, token }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				try {
					let serialized: string
					try {
						serialized = await readFile(path, "utf8")
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
						throw error
					}
					const lock = JSON.parse(serialized) as {
						pid?: unknown
						owner_host?: unknown
						owner_start?: unknown
					}
					if (
						typeof lock.pid !== "number" ||
						!Number.isSafeInteger(lock.pid) ||
						lock.pid < 1 ||
						typeof lock.owner_host !== "string" ||
						typeof lock.owner_start !== "string"
					) {
						throw new ReviewTargetError(
							"review_lock_invalid",
							`Review lock ${path} is malformed; remove only this file after verifying the owner.`,
						)
					}
					if (lock.owner_host !== currentReviewHost()) {
						throw new ReviewTargetError(
							"review_lock_untrusted",
							`Review lock ${path} belongs to another host; it is preserved. Inspect the owner and remove only this file after confirmation.`,
						)
					}
					if (await processAlive(lock.pid)) {
						const currentStart = await reviewProcessStartIdentity(lock.pid)
						if (currentStart === lock.owner_start) throw activeError(checkoutPath)
						// This is PID reuse, not the original owner.
					}
					// Atomically move the stale candidate out of the acquisition path.
					// A competing reclaimer sees ENOENT and retries against the new owner.
					const stale = `${path}.${process.pid}.${token}.stale`
					try {
						await rename(path, stale)
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
						throw error
					}
					const renamed = await readFile(stale, "utf8")
					if (renamed !== serialized) {
						throw new ReviewTargetError(
							"review_lock_changed",
							`Review lock ${path} changed during stale-owner verification; preserved as ${stale}.`,
						)
					}
					// Complete review artifacts are never deleted by this mechanism.
					await unlink(stale)
				} catch (error) {
					if (error instanceof ReviewTargetError) throw error
					throw new ReviewTargetError(
						"review_lock_unreadable",
						`Cannot safely reclaim review lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			} finally {
				await rm(temporary, { force: true }).catch(() => {})
			}
		}
		return undefined
	})
}

export async function acquireReviewOperation(
	ctx: ExtensionCommandContext,
	checkoutPath: string,
	run: LocalReviewRunDirectory,
	ownerIdentity: typeof currentReviewOwnerIdentity = currentReviewOwnerIdentity,
	pendingSignal?: AbortSignal,
): Promise<ReviewOperation> {
	const sessionId = ctx.sessionManager.getSessionId()
	if (activeBySession.has(sessionId) || activeByCheckout.has(checkoutPath)) throw activeError(checkoutPath)
	let resolveCompletion!: () => void
	const completion = new Promise<void>((resolveCompletionPromise) => {
		resolveCompletion = resolveCompletionPromise
	})
	const controller = new AbortController()
	const active: ActiveReview = { checkoutPath, controller, completion, complete: resolveCompletion }
	try {
		const lock = await acquirePersistentLock(checkoutPath, run, ownerIdentity)
		if (!lock)
			throw new ReviewTargetError("review_lock_failed", `Could not acquire the active-review lock for ${checkoutPath}.`)
		active.lockPath = lock.path
		active.lockToken = lock.token
		if (pendingSignal?.aborted) controller.abort(pendingSignal.reason)
		active.detachInput = captureTerminalCancellation(ctx, controller)
		activeBySession.set(sessionId, active)
		activeByCheckout.set(checkoutPath, active)
		return {
			signal: controller.signal,
			runDir: run.runDir,
			get cancelled() {
				return controller.signal.aborted
			},
			completion,
			finish: async () => {
				if (activeBySession.get(sessionId) === active) activeBySession.delete(sessionId)
				if (activeByCheckout.get(checkoutPath) === active) activeByCheckout.delete(checkoutPath)
				active.detachInput?.()
				if (active.lockPath && active.lockToken) {
					try {
						const lock = JSON.parse(await readFile(active.lockPath, "utf8")) as { token?: unknown }
						if (lock.token === active.lockToken) await rm(active.lockPath, { force: true })
					} catch {
						// Never replace or delete another run's lock after a failed release.
					}
				}
				// Cancellation completes only after the persistent lock has been released.
				active.complete()
			},
		}
	} catch (error) {
		active.detachInput?.()
		active.complete()
		if (active.lockPath && active.lockToken) {
			try {
				const lock = JSON.parse(await readFile(active.lockPath, "utf8")) as { token?: unknown }
				if (lock.token === active.lockToken) await rm(active.lockPath, { force: true })
			} catch {
				// The lock may already have been reclaimed by a subsequent invocation.
			}
		}
		throw error
	}
}

/** Called by ACP session/cancel. Resolves only after finalization and cleanup. */
export async function cancelActiveReview(sessionId: string, reason = "Review cancelled by the client"): Promise<void> {
	const active = activeBySession.get(sessionId)
	if (active) {
		if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
		await active.completion
		return
	}
	const pending = pendingBySession.get(sessionId)
	if (pending && !pending.controller.signal.aborted) pending.controller.abort(new Error(reason))
}

export function activeReviewForTest(sessionId: string): { checkoutPath: string; lockPath?: string } | undefined {
	const active = activeBySession.get(sessionId)
	return active ? { checkoutPath: active.checkoutPath, lockPath: active.lockPath } : undefined
}
