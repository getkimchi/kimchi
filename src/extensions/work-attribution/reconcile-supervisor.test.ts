import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as locks from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as transitions from "./file-transitions.js"
import { RECONCILIATION_INTERVAL_MS, subscribeFileReconciliation } from "./reconcile-supervisor.js"

vi.mock("proper-lockfile", async (original) => ({ ...(await original<typeof locks>()) }))
vi.mock("./file-transitions.js", () => ({
	knownTransitionRepositories: vi.fn(),
	reconcileRepositoryTransitions: vi.fn(),
}))

let directory: string
const stops: (() => Promise<void>)[] = []
function subscribe() {
	const stop = subscribeFileReconciliation()
	stops.push(stop)
	return stop
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reconcile-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
	vi.spyOn(transitions, "knownTransitionRepositories").mockResolvedValue(["/repository-a", "/repository-b"])
	vi.spyOn(transitions, "reconcileRepositoryTransitions").mockResolvedValue()
})
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("shared file reconciliation", () => {
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
		await vi.waitFor(() => expect(transitions.reconcileRepositoryTransitions).toHaveBeenCalledTimes(1))
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
