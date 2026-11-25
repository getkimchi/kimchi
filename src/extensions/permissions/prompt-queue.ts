import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Serializes permission prompts: at most one prompt is on screen at a time.
 *
 * Required because pi keeps a single dialog slot — a second `ui.select`
 * silently replaces the first prompt, and the first promise then never
 * resolves (an orphaned prompt would block its tool call forever). With
 * background subagents, escalated permission prompts and the session's own
 * prompts can arrive together, so both go through one queue owned by the
 * session's permissions-extension instance.
 *
 * Entries carry the caller's abort signal so that:
 * - an entry dropped before it is ever shown (aborted while waiting — e.g.
 *   the user cancelled the turn or the permission mode changed) is removed
 *   from the queue and its waiter rejected without running its task, and
 * - an entry whose prompt is orphaned upstream (the prompt was replaced and
 *   the task promise will never settle) does not hold the queue: when the
 *   signal aborts, the waiter is rejected and the next entry starts; the
 *   orphaned task's late settle is ignored.
 */

interface PromptQueueEntry {
	task: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (err: unknown) => void
	signal?: AbortSignal
	onAbort?: () => void
	/** Gives an abort-aware task one turn to settle before releasing the queue. */
	abortTimer?: ReturnType<typeof setTimeout>
	/** Set once the waiter is settled; an orphaned task's late settle is a no-op. */
	finished: boolean
}

export class PromptQueue {
	private readonly queued: PromptQueueEntry[] = []
	private running: PromptQueueEntry | undefined

	/** Entries waiting behind the currently running prompt. */
	get depth(): number {
		return this.queued.length
	}

	/**
	 * Run `task` once every earlier entry has finished. The returned promise
	 * rejects with the signal's abort reason if the signal aborts while the
	 * entry is waiting or while its replaced prompt would otherwise hang.
	 */
	enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const snapshot = AsyncLocalStorage.snapshot()
		if (signal?.aborted) return Promise.reject(signal.reason ?? defaultAbortReason())
		return new Promise<T>((resolve, reject) => {
			const entry: PromptQueueEntry = {
				// pump() may run under the previous prompt's async context. Restore
				// the context of this entry's caller, not whoever completed before it.
				task: () => snapshot(task),
				resolve: resolve as (value: unknown) => void,
				reject,
				finished: false,
			}
			if (signal) {
				entry.signal = signal
				entry.onAbort = () => {
					const reason = signal.reason ?? defaultAbortReason()
					const waitingAt = this.queued.indexOf(entry)
					if (waitingAt >= 0) {
						// Never shown: drop it, the task never runs.
						this.queued.splice(waitingAt, 1)
						entry.finished = true
						entry.reject(reason)
						return
					}
					if (this.running === entry && !entry.finished) {
						// The task gets the first turn to settle its own abort. In
						// particular, a selected "No" becomes a plain denial, not
						// an "aborted" result that can be re-approved under a new
						// mode. If the upstream prompt never settles, the next turn
						// releases it so the queue cannot hang forever.
						entry.abortTimer = setTimeout(() => {
							if (entry.finished) return
							entry.finished = true
							this.detach(entry)
							this.running = undefined
							entry.reject(reason)
							this.pump()
						}, 0)
					}
				}
				signal.addEventListener("abort", entry.onAbort, { once: true })
			}
			this.queued.push(entry)
			this.pump()
		})
	}

	private pump(): void {
		if (this.running) return
		const entry = this.queued.shift()
		if (!entry) return
		this.running = entry
		let task: Promise<unknown>
		try {
			task = entry.task()
		} catch (err) {
			if (entry.finished) return
			entry.finished = true
			this.detach(entry)
			this.running = undefined
			entry.reject(err)
			this.pump()
			return
		}
		task.then(
			(value) => {
				if (entry.finished) return
				entry.finished = true
				this.detach(entry)
				this.running = undefined
				entry.resolve(value)
				this.pump()
			},
			(err) => {
				if (entry.finished) return
				entry.finished = true
				this.detach(entry)
				this.running = undefined
				entry.reject(err)
				this.pump()
			},
		)
	}

	private detach(entry: PromptQueueEntry): void {
		if (entry.abortTimer) clearTimeout(entry.abortTimer)
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort)
	}
}

function defaultAbortReason(): Error {
	return new Error("Permission prompt aborted")
}
