// One background update tick (GLOSSARY.md): acquire the updater lock, check,
// install, report. Never throws — a failed background update is invisible to
// the user by design (recorded in the update result, retried on the next
// tick). See docs/adr/0001-background-auto-update.md.

import { acquireUpdaterLock, type UpdaterLock } from "./lock.js"
import {
	loadLastInstalled,
	saveLastInstalled,
	saveUpdateResult,
	type UpdateOutcome,
	type UpdateResultRecord,
} from "./state.js"
import { applyUpdate, type CheckResult, checkForUpdate } from "./workflow.js"

export type TickOutcome = UpdateOutcome

export interface TickResult {
	outcome: TickOutcome
	/** Target version when the tick resolved one (installed/install-failed). */
	version?: string
	/** Truncated failure reason for failure outcomes. */
	error?: string
}

/** Persisted-state hooks, injectable so ticks stay off the real ~/.cache in
 *  tests. All three write/read under the updater lock the tick already holds,
 *  so concurrent sessions can't lose these diagnostics to a load/save race. */
export interface TickStore {
	saveUpdateResult: (rec: Omit<UpdateResultRecord, "at">) => void
	saveLastInstalled: (tag: string) => void
	loadLastInstalled: () => { tag: string } | null
}

export interface TickDeps {
	currentVersion: string
	/** Injectable for tests; defaults to the real updater lock. */
	acquireLock?: () => UpdaterLock | null
	/** Injectable for tests; structural so stubs don't need the full
	 *  workflow types. Defaults to workflow.js. */
	checkForUpdate?: (opts: {
		currentVersion: string
		skipCache: boolean
		canary: boolean
		signal?: AbortSignal
	}) => Promise<CheckResult>
	applyUpdate?: (opts: { tag: string; signal?: AbortSignal }) => Promise<unknown>
	/** Persistence; defaults to state.js under the updater lock. */
	store?: TickStore
	/** Caller abort (session shutdown) forwarded to the network layers. */
	signal?: AbortSignal
}

/** Telemetry and result-file privacy convention: errors are truncated. */
const MAX_ERROR_LEN = 300

function errorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err)
	return message.length > MAX_ERROR_LEN ? message.slice(0, MAX_ERROR_LEN) : message
}

/**
 * Run one tick. Outcomes are also persisted via `store.saveUpdateResult`
 * BEFORE the lock is released, so a concurrent session can never overwrite
 * the record with a racy load/save. A tick that finds another live holder
 * returns `skipped-lock` — the winner's in-place install covers this machine.
 */
export async function runUpdateTick(deps: TickDeps): Promise<TickResult> {
	const store: TickStore = deps.store ?? { saveUpdateResult, saveLastInstalled, loadLastInstalled }
	const acquire = deps.acquireLock ?? (() => acquireUpdaterLock())
	const lock = acquire()
	if (lock === null) {
		const result: TickResult = { outcome: "skipped-lock" }
		safeSave(store, result)
		return result
	}

	let result: TickResult = { outcome: "check-failed", error: "unexpected tick failure" }
	try {
		result = await computeTick({ ...deps, store }).catch((err) => ({
			outcome: "check-failed",
			error: errorMessage(err),
		}))
	} finally {
		safeSave(store, result)
		if (result.outcome === "installed" && result.version !== undefined) {
			// Record the installed tag under the lock too, so other sessions
			// (still running the old version) dedup against it on their ticks.
			try {
				store.saveLastInstalled(result.version)
			} catch {
				// best-effort
			}
		}
		lock.release()
	}
	return result
}

function safeSave(store: TickStore, result: TickResult): void {
	try {
		store.saveUpdateResult({ outcome: result.outcome, version: result.version, error: result.error })
	} catch {
		// best-effort diagnostics
	}
}

async function computeTick(deps: TickDeps & { store: TickStore }): Promise<TickResult> {
	const store = deps.store
	const check = deps.checkForUpdate ?? checkForUpdate
	let checkResult: CheckResult
	try {
		checkResult = await check({
			currentVersion: deps.currentVersion,
			// Honour the shared 30-minute cache so N open sessions still mean
			// at most one GitHub check per tick interval.
			skipCache: false,
			canary: false,
			signal: deps.signal,
		})
	} catch (err) {
		return { outcome: "check-failed", error: errorMessage(err) }
	}

	if (!checkResult.hasUpdate) return { outcome: "no-update" }

	// Dedup: this session's own version is process-lifetime cached (the
	// install applies to the NEXT launch), so hasUpdate stays true even
	// right after this machine installed exactly this release in another
	// session. Compare against the recorded last-installed tag instead.
	if (store.loadLastInstalled()?.tag === checkResult.tag) return { outcome: "no-update" }

	try {
		await (deps.applyUpdate ?? applyUpdate)({ tag: checkResult.tag, signal: deps.signal })
		return { outcome: "installed", version: checkResult.latestVersion }
	} catch (err) {
		return {
			outcome: "install-failed",
			version: checkResult.latestVersion,
			error: errorMessage(err),
		}
	}
}
