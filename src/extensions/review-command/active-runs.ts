import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rm, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { ReviewTargetError } from "../review-targets/types.js"
import { currentReviewHost, currentReviewOwnerIdentity, reviewProcessStartIdentity } from "./owner-identity.js"

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

export interface ReviewOperation {
	signal: AbortSignal
	readonly runDir: string
	readonly cancelled: boolean
	readonly completion: Promise<void>
	finish: () => Promise<void>
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

async function acquirePersistentLock(
	checkoutPath: string,
	runDir: string,
): Promise<{ path: string; token: string } | undefined> {
	const path = resolve(dirname(runDir), "..", "active-review.json")
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = randomUUID()
		try {
			await mkdir(dirname(path), { recursive: true })
			const handle = await open(path, "wx", 0o600)
			try {
				const owner = await currentReviewOwnerIdentity()
				await handle.writeFile(
					`${JSON.stringify({ token, pid: process.pid, checkoutPath, runDir, owner_host: owner.hostname, owner_start: owner.startIdentity })}\n`,
					"utf8",
				)
				await handle.sync()
			} finally {
				await handle.close()
			}
			return { path, token }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			try {
				const lock = JSON.parse(await readFile(path, "utf8")) as {
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
				// Dead PID or a provably different process start. Complete review
				// artifacts are never deleted by this mechanism.
				await unlink(path)
			} catch (error) {
				if (error instanceof ReviewTargetError && error.code === "review_in_progress") throw error
				if (error instanceof ReviewTargetError) throw error
				throw new ReviewTargetError(
					"review_lock_unreadable",
					`Cannot safely reclaim review lock ${path}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}
	return undefined
}

export async function acquireReviewOperation(
	ctx: ExtensionCommandContext,
	checkoutPath: string,
	runDir: string,
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
		const lock = await acquirePersistentLock(checkoutPath, runDir)
		if (!lock)
			throw new ReviewTargetError("review_lock_failed", `Could not acquire the active-review lock for ${checkoutPath}.`)
		active.lockPath = lock.path
		active.lockToken = lock.token
		if (ctx.hasUI) {
			active.detachInput = ctx.ui.onTerminalInput((data) => {
				if (data !== "\u001b" && data !== "\u0003") return undefined
				if (!controller.signal.aborted) controller.abort(new Error("Review interrupted by the user."))
				return { consume: true }
			})
		}
		activeBySession.set(sessionId, active)
		activeByCheckout.set(checkoutPath, active)
		return {
			signal: controller.signal,
			runDir,
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
	if (!active) return
	if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
	await active.completion
}

export function activeReviewForTest(sessionId: string): { checkoutPath: string; lockPath?: string } | undefined {
	const active = activeBySession.get(sessionId)
	return active ? { checkoutPath: active.checkoutPath, lockPath: active.lockPath } : undefined
}
