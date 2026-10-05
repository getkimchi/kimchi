import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as locks from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as pullRequests from "../pull-request-status/pull-requests.js"
import * as costs from "./cost-sync.js"
import * as transitions from "./file-transitions.js"
import * as continuations from "./links.js"
import {
	RECONCILIATION_INTERVAL_MS,
	subscribeCostReconciliation,
	subscribeFileReconciliation,
	subscribePullRequestReconciliation,
	subscribeReportingReconciliation,
} from "./reconcile-supervisor.js"

vi.mock("proper-lockfile", async (original) => ({ ...(await original<typeof locks>()) }))
vi.mock("./file-transitions.js", () => ({
	knownTransitionRepositories: vi.fn(),
	reconcileRepositoryTransitions: vi.fn(),
}))
vi.mock("../pull-request-status/pull-requests.js", () => ({
	reconcileWorkPullRequests: vi.fn(),
	readWorkPullRequestUpdates: vi.fn(),
}))
vi.mock("./cost-sync.js", () => ({ reconcileWorkCosts: vi.fn() }))
vi.mock("./links.js", () => ({ reconcileWorkContinuations: vi.fn() }))

let directory: string
const stops: (() => Promise<void>)[] = []
function subscribe() {
	const stop = subscribeFileReconciliation()
	stops.push(stop)
	return stop
}
function subscribePr() {
	const stop = subscribePullRequestReconciliation({ onPullRequest: () => {} })
	stops.push(stop)
	return stop
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reconcile-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
	vi.spyOn(transitions, "knownTransitionRepositories").mockResolvedValue(["/repository-a", "/repository-b"])
	vi.spyOn(transitions, "reconcileRepositoryTransitions").mockResolvedValue()
	vi.mocked(pullRequests.reconcileWorkPullRequests).mockResolvedValue()
	vi.mocked(pullRequests.readWorkPullRequestUpdates).mockReturnValue([])
	vi.mocked(costs.reconcileWorkCosts).mockResolvedValue()
	vi.mocked(continuations.reconcileWorkContinuations).mockResolvedValue()
})
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("shared file reconciliation", () => {
	it("runs optional reporting after costs and historical repair and cancels only that subscription", async () => {
		const order: string[] = []
		vi.mocked(costs.reconcileWorkCosts).mockImplementation(async () => {
			order.push("costs")
		})
		vi.mocked(continuations.reconcileWorkContinuations).mockImplementation(async () => {
			order.push("history")
		})
		subscribe()
		stops.push(subscribeCostReconciliation())
		let reportSignal: AbortSignal | undefined
		const stop = subscribeReportingReconciliation(async (_directory, signal, assertLease) => {
			assertLease()
			order.push("reporting")
			reportSignal = signal
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
		})
		stops.push(stop)
		await vi.waitFor(() => expect(order).toEqual(["costs", "history", "reporting"]))
		await stop()
		expect(reportSignal?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(1)
	})
	it("runs PR and cost work before a failed historical repair and retries without a PR warning", async () => {
		const order: string[] = []
		const onError = vi.fn()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(pullRequests.reconcileWorkPullRequests).mockImplementation(async () => {
			order.push("pr")
		})
		vi.mocked(costs.reconcileWorkCosts).mockImplementation(async () => {
			order.push("cost")
		})
		vi.mocked(continuations.reconcileWorkContinuations).mockImplementation(async () => {
			order.push("history")
			throw new Error("Unreadable historical ledger")
		})
		subscribe()
		stops.push(subscribePullRequestReconciliation({ onPullRequest: () => {}, onError }))
		stops.push(subscribeCostReconciliation())
		await vi.waitFor(() => expect(order).toEqual(["pr", "cost", "history"]))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(order).toEqual(["pr", "cost", "history", "pr", "cost", "history"]))
		expect(onError).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it("gives historical repair a fresh budget after local Git uses its budget", async () => {
		let now = 0
		vi.spyOn(Date, "now").mockImplementation(() => now)
		vi.mocked(transitions.reconcileRepositoryTransitions).mockImplementation(async (_repository, _signal, budget) => {
			now += 4000
			budget?.()
		})
		const published = vi.fn()
		vi.mocked(continuations.reconcileWorkContinuations).mockImplementation(async (_directory, signal, assertLease) => {
			signal.throwIfAborted()
			assertLease()
			published()
		})
		subscribe()
		await vi.waitFor(() => expect(published).toHaveBeenCalledOnce())
	})

	it("passes lease loss to a historical repair before it can publish", async () => {
		let compromised: locks.LockOptions["onCompromised"]
		vi.spyOn(locks, "lock").mockImplementation(async (_path, options) => {
			compromised = options?.onCompromised
			return async () => {}
		})
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let active: AbortSignal | undefined
		const published = vi.fn()
		vi.mocked(continuations.reconcileWorkContinuations).mockImplementation(async (_directory, signal, assertLease) => {
			active = signal
			await gate
			assertLease()
			published()
		})
		const stop = subscribe()
		try {
			await vi.waitFor(() => expect(active).toBeDefined())
			compromised?.(Object.assign(new Error("Lease lost"), { code: "ECOMPROMISED" }))
			finish()
			await stop()
			expect(active?.aborted).toBe(true)
			expect(published).not.toHaveBeenCalled()
		} finally {
			finish()
		}
	})

	it("keeps billing write failures out of PR warnings and retries billing on the next pass", async () => {
		const onError = vi.fn()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(costs.reconcileWorkCosts).mockRejectedValueOnce(new Error("Could not save cost report"))
		stops.push(subscribePullRequestReconciliation({ onPullRequest: () => {}, onError }))
		stops.push(subscribeCostReconciliation())
		await vi.waitFor(() => expect(costs.reconcileWorkCosts).toHaveBeenCalledOnce())
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		expect(onError).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(costs.reconcileWorkCosts).toHaveBeenCalledTimes(2))
		expect(pullRequests.reconcileWorkPullRequests).toHaveBeenCalledTimes(2)
	})

	it("keeps local Git failures out of PR warnings while reporting a failed PR lookup", async () => {
		const onError = vi.fn()
		const lookupError = new Error("PR lookup unavailable")
		vi.mocked(transitions.reconcileRepositoryTransitions).mockRejectedValueOnce(new Error("Git timed out"))
		vi.mocked(pullRequests.reconcileWorkPullRequests).mockRejectedValueOnce(lookupError)
		subscribe()
		stops.push(subscribePullRequestReconciliation({ onPullRequest: () => {}, onError }))
		await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(lookupError))
		expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2)
	})

	it("keeps a failed repository off the console, scans its sibling and retries on the next pass", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = Object.assign(new Error("Git timed out"), { code: null, killed: true, signal: "SIGTERM" })
		vi.mocked(transitions.reconcileRepositoryTransitions).mockRejectedValueOnce(error)
		subscribe()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4))
		expect(vi.mocked(transitions.reconcileRepositoryTransitions).mock.calls.map(([repository]) => repository)).toEqual([
			"/repository-a",
			"/repository-b",
			"/repository-a",
			"/repository-b",
		])
		expect(warn).not.toHaveBeenCalled()
	})

	it("keeps a discovery failure off the console and retries on the next pass", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(transitions.knownTransitionRepositories).mockRejectedValueOnce(new Error("Cannot read journals"))
		subscribe()
		await vi.waitFor(() => expect(transitions.knownTransitionRepositories).toHaveBeenCalledTimes(1))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
		expect(warn).not.toHaveBeenCalled()
	})

	it("uses the same worker for costs and aborts only cost work when its subscriber leaves", async () => {
		let active: AbortSignal | undefined
		vi.mocked(costs.reconcileWorkCosts).mockImplementation(async (_directory, signal) => {
			active = signal
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
		})
		subscribe()
		const stop = subscribeCostReconciliation()
		stops.push(stop)
		await vi.waitFor(() => expect(active).toBeDefined())
		await stop()
		expect(active?.aborted).toBe(true)
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4))
		expect(costs.reconcileWorkCosts).toHaveBeenCalledOnce()
	})
	it("does not read PR records or call GitHub when only file reconciliation is enabled", async () => {
		subscribe()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
		expect(pullRequests.readWorkPullRequestUpdates).not.toHaveBeenCalled()
		expect(pullRequests.reconcileWorkPullRequests).not.toHaveBeenCalled()
	})
	it("stops only PR network work while local reconciliation remains subscribed", async () => {
		let active: AbortSignal | undefined
		vi.mocked(pullRequests.reconcileWorkPullRequests).mockImplementation(async (_directory, signal) => {
			active = signal
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
		})
		subscribe()
		const stopPr = subscribePr()
		await vi.waitFor(() => expect(active).toBeDefined())
		await stopPr()
		expect(active?.aborted).toBe(true)
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4))
		expect(pullRequests.reconcileWorkPullRequests).toHaveBeenCalledOnce()
	})
	it("shows another process's saved results while that process owns the lookup lease", async () => {
		const path = join(directory, "work-attribution")
		mkdirSync(path)
		const release = await locks.lock(path)
		const update = {
			workId: "11111111-1111-4111-8111-111111111111",
			sessionId: "other-process",
			cwd: "/repo",
			repository: "/repo/.git",
			worktree: "/repo",
			sha: "a".repeat(40),
			pullRequests: [],
			prLookup: { status: "pending" as const, checkedAt: new Date().toISOString() },
		}
		vi.mocked(pullRequests.readWorkPullRequestUpdates).mockReturnValue([update])
		const onPullRequest = vi.fn()
		const stop = subscribePullRequestReconciliation({ onPullRequest })
		stops.push(stop)
		try {
			await vi.waitFor(() => expect(onPullRequest).toHaveBeenCalledWith(update))
			expect(pullRequests.reconcileWorkPullRequests).not.toHaveBeenCalled()
			expect(transitions.reconcileRepositoryTransitions).not.toHaveBeenCalled()
			const failed = {
				...update,
				prLookup: { status: "error" as const, checkedAt: new Date().toISOString(), error: "Run gh auth login" },
			}
			vi.mocked(pullRequests.readWorkPullRequestUpdates).mockReturnValue([failed])
			await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
			await vi.waitFor(() => expect(onPullRequest).toHaveBeenLastCalledWith(failed))
			expect(pullRequests.reconcileWorkPullRequests).not.toHaveBeenCalled()
		} finally {
			await stop()
			await release()
		}
	})

	it("discovers Bash-only commits even when there are no file-transition repositories", async () => {
		vi.mocked(transitions.knownTransitionRepositories).mockResolvedValue([])
		subscribePr()
		await vi.waitFor(() => expect(pullRequests.reconcileWorkPullRequests).toHaveBeenCalledTimes(1))
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(pullRequests.reconcileWorkPullRequests).toHaveBeenCalledTimes(2))
	})

	it("aborts and drains the GitHub lookup when its owner shuts down", async () => {
		let active: AbortSignal | undefined
		vi.mocked(pullRequests.reconcileWorkPullRequests).mockImplementation(async (_directory, signal) => {
			active = signal
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
		})
		const stop = subscribePr()
		await vi.waitFor(() => expect(active).toBeDefined())
		await stop()
		expect(active?.aborted).toBe(true)
	})
	it("starts a new scan when another top-level session subscribes after the owner became idle", async () => {
		subscribe()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		subscribe()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4))
		expect(transitions.knownTransitionRepositories).toHaveBeenCalledTimes(2)
	})

	it("uses one owner for startup and periodic scans and releases it after the last subscriber", async () => {
		const first = subscribe()
		const second = subscribe()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
		expect(transitions.knownTransitionRepositories).toHaveBeenCalledTimes(1)
		await first()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4))
		await second()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(4)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not overlap scans and aborts then drains only when the last subscriber leaves", async () => {
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let active: AbortSignal | undefined
		vi.mocked(transitions.reconcileRepositoryTransitions).mockImplementation(async (_repository, signal) => {
			active = signal
			await gate
		})
		const first = subscribe()
		const last = subscribe()
		try {
			await vi.waitFor(() => expect(active).toBeDefined())
			await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS * 2)
			expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(1)
			await first()
			expect(active?.aborted).toBe(false)
			let stopped = false
			const drained = last().then(() => {
				stopped = true
			})
			await Promise.resolve()
			expect(active?.aborted).toBe(true)
			expect(stopped).toBe(false)
			finish()
			await drained
			expect(stopped).toBe(true)
		} finally {
			finish()
		}
	})

	it("skips another process's lease without waiting and retries on the next interval", async () => {
		const path = join(directory, "work-attribution")
		mkdirSync(path)
		const release = await locks.lock(path)
		const attempt = vi.spyOn(locks, "lock")
		subscribe()
		try {
			await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1))
			await vi.waitFor(() => expect(attempt.mock.results[0].value).rejects.toMatchObject({ code: "ELOCKED" }))
			expect(transitions.reconcileRepositoryTransitions).not.toHaveBeenCalled()
		} finally {
			await release()
		}
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(2))
	})

	it("moves a slow repository behind the other repositories on the next bounded pass", async () => {
		let now = 0
		vi.spyOn(Date, "now").mockImplementation(() => now)
		vi.mocked(transitions.reconcileRepositoryTransitions).mockImplementation(
			async (repository, _signal, checkBudget) => {
				if (repository === "/repository-a") now += 4000
				checkBudget?.()
			},
		)
		subscribe()
		subscribePr()
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(1))
		await vi.waitFor(() => expect(pullRequests.reconcileWorkPullRequests).toHaveBeenCalledTimes(1))
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(3))
		expect(vi.mocked(transitions.reconcileRepositoryTransitions).mock.calls.map(([repository]) => repository)).toEqual([
			"/repository-a",
			"/repository-b",
			"/repository-a",
		])
	})

	it("cancels and prevents publication if the cross-process lease is lost", async () => {
		let compromised: locks.LockOptions["onCompromised"]
		const release = vi.fn(async () => {})
		vi.spyOn(locks, "lock").mockImplementation(async (_path, options) => {
			compromised = options?.onCompromised
			return release
		})
		const published = vi.fn()
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let active: AbortSignal | undefined
		vi.mocked(transitions.reconcileRepositoryTransitions).mockImplementation(
			async (_repository, signal, _budget, assertLease) => {
				active = signal
				await gate
				assertLease?.()
				published()
			},
		)
		const stop = subscribe()
		try {
			await vi.waitFor(() => expect(active).toBeDefined())
			compromised?.(Object.assign(new Error("lease stolen"), { code: "ECOMPROMISED" }))
			expect(active?.aborted).toBe(true)
			finish()
			await stop()
			expect(published).not.toHaveBeenCalled()
			expect(release).not.toHaveBeenCalled()
		} finally {
			finish()
		}
	})
})
