import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
	ContinuationProgress,
	PassInput,
	PassRun as PassResult,
	ReconcileChannel,
} from "@getkimchi/kimchi-bridge/reconcile"
import { readWorkPullRequestUpdates, runReconciliationPass } from "@getkimchi/kimchi-bridge/reconcile"
import * as locks from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	RECONCILIATION_INTERVAL_MS,
	requestWorkReconciliation,
	resolveFirstTickDelayMs,
	resolveReconciliationIntervalMs,
	subscribeCostReconciliation,
	subscribeFileReconciliation,
	subscribePullRequestReconciliation,
	subscribeReportingReconciliation,
} from "./reconcile-supervisor.js"

/**
 * The channel order, budgets and lease semantics live in the bridge pass
 * (kimchi-bridge test/reconcile — "the pass equals the supervisor's scan() end
 * state"). This suite pins what stayed in Kimchi: the timer, the first-tick
 * delay, the cross-process lease, the subscriber registry and per-channel
 * cancellation, and the PassInput the supervisor hands the pass (enabled
 * channels, the reporting session's cwd, the nextRepository rotation and the
 * cross-pass continuation progress).
 */
vi.mock("@getkimchi/kimchi-bridge/reconcile", () => ({
	debugWorkAttribution: vi.fn(),
	readWorkPullRequestUpdates: vi.fn(),
	runReconciliationPass: vi.fn(),
	setDefaultHostPorts: vi.fn(),
}))
vi.mock("proper-lockfile", async (original) => ({ ...(await original<typeof locks>()) }))

const mockedReadUpdates = vi.mocked(readWorkPullRequestUpdates)
const mockedRunPass = vi.mocked(runReconciliationPass)

/** Every PassInput the supervisor handed the (mocked) pass, in pass order. */
const passInputs: PassInput[] = []
/** The fake pass's result; tests steer rotation and progress threading through it. */
let passResult: PassResult
/** Per-test pass body: gates and channel aborts live here, not in the supervisor. */
let passBody: ((input: PassInput, io: { signal: AbortSignal; assertLease: () => void }) => Promise<void>) | undefined
/** First-error injection: one failing pass, then healthy passes again. */
let passError: unknown

function okChannels(): Record<ReconcileChannel, { outcome: "ok" }> {
	return {
		files: { outcome: "ok" },
		"pull-requests": { outcome: "ok" },
		costs: { outcome: "ok" },
		continuations: { outcome: "ok" },
		reporting: { outcome: "ok" },
	}
}

/** Resolves when signal aborts. */
function aborted(signal: AbortSignal): Promise<void> {
	return signal.aborted
		? Promise.resolve()
		: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

let directory: string
/**
 * `vi.waitFor` defaults to a 1 s budget on real timers. A reconciliation tick takes a real
 * `proper-lockfile` lock and runs async work, which a loaded CI runner can outlast — the
 * "stops only PR network work" case failed that way (spy called 2 times, expected 4).
 */
const _RECONCILIATION_WAIT_TIMEOUT_MS = 10_000
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
/**
 * A pass keeps the supervisor busy until its lock release has finished, and a
 * tick in that time is skipped. The lock directory goes away first; the code
 * that ends the pass runs later in the same loop turn, before setImmediate.
 */
async function passFinished() {
	await vi.waitFor(() => expect(existsSync(join(directory, "work-attribution.lock"))).toBe(false), {
		timeout: 4_000,
	})
	await new Promise((resolve) => setImmediate(resolve))
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reconcile-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	// Existing behaviour tests subscribe and expect a pass immediately.
	vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "0")
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
	passInputs.length = 0
	passBody = undefined
	passError = undefined
	passResult = { channels: okChannels(), progress: {} }
	mockedReadUpdates.mockReset().mockReturnValue([])
	mockedRunPass.mockReset().mockImplementation(async (input, _host, io) => {
		passInputs.push(input)
		if (passBody) await passBody(input, io)
		if (passError) {
			const error = passError
			passError = undefined
			throw error
		}
		return passResult
	})
})
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS seam", () => {
	it("returns the 30 s default when the seam is unset", () => {
		expect(resolveReconciliationIntervalMs()).toBe(30_000)
	})

	it("honors a positive integer override inside the test harness", () => {
		vi.stubEnv("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS", "1000")
		expect(resolveReconciliationIntervalMs()).toBe(1000)
	})

	it.each(["0", "-5", "1.5", "abc"])("falls back to 30 s for %s", (value) => {
		vi.stubEnv("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS", value)
		expect(resolveReconciliationIntervalMs()).toBe(30_000)
	})

	it("the exported const is bound once at module load", async () => {
		expect(RECONCILIATION_INTERVAL_MS).toBe(30_000)
		vi.stubEnv("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS", "500")
		vi.resetModules()
		try {
			const fresh = await import("./reconcile-supervisor.js")
			expect(fresh.RECONCILIATION_INTERVAL_MS).toBe(500)
		} finally {
			vi.resetModules()
		}
	})
})

describe("KIMCHI_E2E_FIRST_TICK_DELAY_MS seam", () => {
	it("returns the 5 s default when the seam is unset", () => {
		vi.unstubAllEnvs()
		expect(resolveFirstTickDelayMs()).toBe(5000)
	})

	it("honors zero and positive integer overrides", () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "200")
		expect(resolveFirstTickDelayMs()).toBe(200)
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "0")
		expect(resolveFirstTickDelayMs()).toBe(0)
	})

	it.each(["-5", "1.5", "abc"])("falls back to 5 s for %s", (value) => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", value)
		expect(resolveFirstTickDelayMs()).toBe(5000)
	})

	it("treats a present-but-blank seam value as unset, not as zero", () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "")
		expect(resolveFirstTickDelayMs()).toBe(5000)
	})

	it("defers the first pass until the delay elapses (real short delay; interval stays faked)", async () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "100")
		stops.push(subscribeReportingReconciliation(() => "/session-cwd"))
		await Promise.resolve()
		expect(mockedRunPass).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledOnce())
	})

	it("an explicit request inside the window runs the pass once without a duplicate first tick", async () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "100")
		stops.push(subscribeReportingReconciliation(() => "/session-cwd"))
		requestWorkReconciliation()
		await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledOnce())
		// Well past the window: the delayed first tick must not re-run a pass.
		await new Promise((resolve) => setTimeout(resolve, 250))
		expect(mockedRunPass).toHaveBeenCalledOnce()
	})

	it("a subscriber joining after the window's first pass ticks a fresh pass, not the interval", async () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "100")
		stops.push(subscribeReportingReconciliation(() => "/session-cwd"))
		// An explicit request runs the window's first pass while the delayed tick is pending.
		requestWorkReconciliation()
		await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledOnce())
		// Let that pass finish before a second view mounts.
		await passFinished()
		// The joiner ticks at once — the startup window is over in substance once a pass has run —
		// and the fresh pass serves the reporting channel again instead of waiting for the interval.
		stops.push(subscribeCostReconciliation())
		await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledTimes(2))
		// The cleared delayed tick never adds a third pass.
		await new Promise((resolve) => setTimeout(resolve, 250))
		expect(mockedRunPass).toHaveBeenCalledTimes(2)
	})

	it("unsubscribing the last subscriber before the delay cancels the first pass", async () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "100")
		const stop = subscribeReportingReconciliation(() => "/session-cwd")
		await stop()
		await new Promise((resolve) => setTimeout(resolve, 250))
		expect(mockedRunPass).not.toHaveBeenCalled()
	})

	it("a subscriber joining inside the window drains durable updates without kicking off the scan", async () => {
		// The window must stay open for the whole test, even on a slow runner.
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "60000")
		const first = vi.fn()
		const second = vi.fn()
		mockedReadUpdates.mockReturnValue([
			{
				workId: "11111111-1111-4111-8111-111111111111",
				sessionId: "session-1",
				cwd: "/repository-a",
				repository: "/repository-a/.git",
				worktree: "/repository-a",
				sha: "a".repeat(40),
				pullRequests: [],
			},
		])
		stops.push(subscribePullRequestReconciliation({ onPullRequest: first }))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(mockedRunPass).not.toHaveBeenCalled()
		expect(first).toHaveBeenCalledOnce()
		// Joining mid-window: still no scan, but the durable drain broadcasts to
		// every current subscriber — the first hears the update again.
		stops.push(subscribePullRequestReconciliation({ onPullRequest: second }))
		await Promise.resolve()
		expect(mockedRunPass).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledOnce()
		expect(first).toHaveBeenCalledTimes(2)
	})

	it("a subscriber joining after the window still gets an immediate tick", async () => {
		vi.stubEnv("KIMCHI_E2E_FIRST_TICK_DELAY_MS", "60")
		const report = vi.fn(() => "/session-cwd")
		stops.push(
			subscribeReportingReconciliation(() => {
				report()
				return "/session-cwd"
			}),
		)
		// Wait for the pass, not a fixed time: after a stall the test timer can
		// run before the pass's first disk call has finished.
		await vi.waitFor(() => expect(report).toHaveBeenCalled(), { timeout: 4_000 })
		await passFinished()
		expect(mockedRunPass).toHaveBeenCalled()
		vi.clearAllMocks()
		stops.push(subscribeReportingReconciliation(report))
		await vi.waitFor(() => expect(report).toHaveBeenCalled(), { timeout: 4_000 })
	})
})

describe("shared file reconciliation", () => {
	it("coalesces immediate refreshes during a running pass without overlap or waiting for the interval", async () => {
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let active = 0
		let maximum = 0
		passBody = async () => {
			maximum = Math.max(maximum, ++active)
			await gate
			active--
		}
		stops.push(subscribeReportingReconciliation(() => "/session-cwd"))
		try {
			await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledOnce())
			requestWorkReconciliation()
			requestWorkReconciliation()
			requestWorkReconciliation()
			expect(mockedRunPass).toHaveBeenCalledOnce()
			finish()
			await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledTimes(2))
			expect(maximum).toBe(1)
		} finally {
			finish()
		}
	})
	it("discards a requested refresh when the last subscriber shuts down", async () => {
		passBody = async (_input, io) => {
			await aborted(io.signal)
		}
		const stop = subscribeReportingReconciliation(() => "/session-cwd")
		stops.push(stop)
		await vi.waitFor(() => expect(mockedRunPass).toHaveBeenCalledOnce())
		requestWorkReconciliation()
		await stop()
		requestWorkReconciliation()
		expect(mockedRunPass).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})
	it("enables exactly the subscribed channels and reads the reporting cwd fresh every pass", async () => {
		let cwd = "/first-cwd"
		subscribe()
		stops.push(subscribeCostReconciliation())
		const stopReporting = subscribeReportingReconciliation(() => cwd)
		stops.push(stopReporting)
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		expect(passInputs[0].files).toBe(true)
		expect(passInputs[0].costs).toEqual({ signal: expect.any(AbortSignal) })
		expect(passInputs[0].pullRequests).toBeUndefined()
		expect(passInputs[0].reporting).toEqual({ cwd: "/first-cwd", signal: expect.any(AbortSignal) })
		// The old onReport closure read its captured context at every pass; the
		// cwd getter is read fresh at every pass the same way.
		cwd = "/second-cwd"
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
		expect(passInputs[1].reporting).toEqual({ cwd: "/second-cwd", signal: expect.any(AbortSignal) })
		// A reporting subscriber leaving without its cwd stops the channel entirely.
		cwd = ""
		cwd = undefined as unknown as string
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(3))
		expect(passInputs[2].reporting).toBeUndefined()
		expect(passInputs[2].files).toBe(true)
	})
	it("aborts only the reporting subscription's channel and keeps the supervisor running", async () => {
		subscribe()
		let reportSignal: AbortSignal | undefined
		passBody = async (input) => {
			if (input.reporting) {
				reportSignal = input.reporting.signal
				await aborted(input.reporting.signal!)
			}
		}
		const stop = subscribeReportingReconciliation(() => "/session-cwd")
		stops.push(stop)
		await vi.waitFor(() => expect(reportSignal).toBeDefined())
		await stop()
		expect(reportSignal?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(1)
	})
	it("routes pull-request channel errors to the PR subscribers only", async () => {
		const onError = vi.fn()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const lookupError = new Error("PR lookup unavailable")
		subscribe()
		stops.push(subscribePullRequestReconciliation({ onPullRequest: () => {}, onError }))
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		// The pass calls the channel's onError; the supervisor forwards it to the
		// PR subscribers (the old reportError owner routing).
		await passInputs[0].pullRequests?.onError?.(lookupError)
		expect(onError).toHaveBeenCalledExactlyOnceWith(lookupError)
		expect(warn).not.toHaveBeenCalled()
	})
	it("retries a failed pass on the next interval without console warnings", async () => {
		const onError = vi.fn()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		passError = new Error("Could not save cost report")
		subscribe()
		stops.push(subscribePullRequestReconciliation({ onPullRequest: () => {}, onError }))
		stops.push(subscribeCostReconciliation())
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		expect(onError).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
	})
	it("threads the pass result's rotation and continuation progress into the next pass", async () => {
		const progress: ContinuationProgress = { nextContinuation: "journal-a" }
		passResult = { nextRepository: "/repository-b", channels: okChannels(), progress }
		subscribe()
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		expect(passInputs[0].nextRepository).toBeUndefined()
		expect(passInputs[0].progress).toBeUndefined()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
		// The supervisor persisted the returned rotation and progress and handed
		// them back — the old owner.nextRepository / owner-as-ContinuationProgress.
		expect(passInputs[1].nextRepository).toBe("/repository-b")
		expect(passInputs[1].progress).toBe(progress)
	})
	it("passes lease loss into the pass and prevents work after the compromise", async () => {
		let compromised: locks.LockOptions["onCompromised"]
		vi.spyOn(locks, "lock").mockImplementation(async (_path, options) => {
			compromised = options?.onCompromised
			return async () => {}
		})
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let assertLease: (() => void) | undefined
		const published = vi.fn()
		passBody = async (_input, io) => {
			assertLease = io.assertLease
			await gate
			io.assertLease()
			published()
		}
		const stop = subscribe()
		try {
			await vi.waitFor(() => expect(assertLease).toBeDefined())
			compromised?.(Object.assign(new Error("Lease lost"), { code: "ECOMPROMISED" }))
			finish()
			await stop()
			expect(published).not.toHaveBeenCalled()
		} finally {
			finish()
		}
	})
	it("uses the same worker for costs and aborts only cost work when its subscriber leaves", async () => {
		let costSignal: AbortSignal | undefined
		passBody = async (input) => {
			if (input.costs && typeof input.costs === "object" && input.costs.signal) {
				costSignal = input.costs.signal
				await aborted(input.costs.signal)
			}
		}
		subscribe()
		const stop = subscribeCostReconciliation()
		stops.push(stop)
		await vi.waitFor(() => expect(costSignal).toBeDefined())
		await stop()
		expect(costSignal?.aborted).toBe(true)
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
		// The cost channel left with its subscriber; files reconciliation continues.
		expect(passInputs[1].costs).toBeUndefined()
		expect(passInputs[1].files).toBe(true)
	})
	it("does not read PR records or enable the PR channel when only file reconciliation is subscribed", async () => {
		subscribe()
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		expect(passInputs[0].pullRequests).toBeUndefined()
		expect(mockedReadUpdates).not.toHaveBeenCalled()
	})
	it("stops only PR network work while local reconciliation remains subscribed", async () => {
		let prSignal: AbortSignal | undefined
		passBody = async (input) => {
			if (input.pullRequests?.signal) {
				prSignal = input.pullRequests.signal
				await aborted(input.pullRequests.signal)
			}
		}
		subscribe()
		const stopPr = subscribePr()
		await vi.waitFor(() => expect(prSignal).toBeDefined())
		await stopPr()
		expect(prSignal?.aborted).toBe(true)
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
		// The PR channel left with its subscriber; file reconciliation keeps running.
		expect(passInputs[1].pullRequests).toBeUndefined()
		expect(passInputs[1].files).toBe(true)
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
		mockedReadUpdates.mockReturnValue([update])
		const onPullRequest = vi.fn()
		const stop = subscribePullRequestReconciliation({ onPullRequest })
		stops.push(stop)
		try {
			await vi.waitFor(() => expect(onPullRequest).toHaveBeenCalledWith(update))
			expect(mockedRunPass).not.toHaveBeenCalled()
			const failed = {
				...update,
				prLookup: { status: "error" as const, checkedAt: new Date().toISOString(), error: "Run gh auth login" },
			}
			mockedReadUpdates.mockReturnValue([failed])
			await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
			await vi.waitFor(() => expect(onPullRequest).toHaveBeenLastCalledWith(failed))
			expect(mockedRunPass).not.toHaveBeenCalled()
		} finally {
			await stop()
			await release()
		}
	})

	it("enables the PR channel without file subscribers (Bash-only commits)", async () => {
		subscribePr()
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		expect(passInputs[0].pullRequests).toEqual({
			onUpdate: expect.any(Function),
			onError: expect.any(Function),
			signal: expect.any(AbortSignal),
		})
		expect(passInputs[0].files).toBeUndefined()
	})

	it("aborts and drains the GitHub lookup when its owner shuts down", async () => {
		let prSignal: AbortSignal | undefined
		passBody = async (input) => {
			if (input.pullRequests?.signal) {
				prSignal = input.pullRequests.signal
				await aborted(input.pullRequests.signal)
			}
		}
		const stop = subscribePr()
		await vi.waitFor(() => expect(prSignal).toBeDefined())
		await stop()
		expect(prSignal?.aborted).toBe(true)
	})
	it("starts a new scan when another top-level session subscribes after the owner became idle", async () => {
		subscribe()
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		await vi.waitFor(async () => {
			const release = await locks.lock(join(directory, "work-attribution"), { retries: 0 })
			await release()
		})
		subscribe()
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
	})

	it("uses one owner for startup and periodic scans and releases it after the last subscriber", async () => {
		const first = subscribe()
		const second = subscribe()
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
		await first()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(2))
		await second()
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		expect(passInputs.length).toBe(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not overlap scans and aborts then drains only when the last subscriber leaves", async () => {
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		let passSignal: AbortSignal | undefined
		passBody = async (_input, io) => {
			passSignal = io.signal
			await gate
		}
		const first = subscribe()
		const last = subscribe()
		try {
			await vi.waitFor(() => expect(passSignal).toBeDefined())
			await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS * 2)
			expect(passInputs.length).toBe(1)
			await first()
			expect(passSignal?.aborted).toBe(false)
			let stopped = false
			const drained = last().then(() => {
				stopped = true
			})
			await Promise.resolve()
			expect(passSignal?.aborted).toBe(true)
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
			expect(passInputs.length).toBe(0)
		} finally {
			await release()
		}
		await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS)
		await vi.waitFor(() => expect(passInputs.length).toBe(1))
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
		let passSignal: AbortSignal | undefined
		passBody = async (_input, io) => {
			passSignal = io.signal
			await gate
			io.assertLease()
			published()
		}
		const stop = subscribe()
		try {
			await vi.waitFor(() => expect(passSignal).toBeDefined())
			compromised?.(Object.assign(new Error("lease stolen"), { code: "ECOMPROMISED" }))
			expect(passSignal?.aborted).toBe(true)
			finish()
			await stop()
			expect(published).not.toHaveBeenCalled()
			expect(release).not.toHaveBeenCalled()
		} finally {
			finish()
		}
	})
})
