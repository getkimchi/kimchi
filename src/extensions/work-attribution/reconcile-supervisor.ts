import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import {
	type ContinuationProgress,
	debugWorkAttribution as debug,
	type PassInput,
	readWorkPullRequestUpdates,
	runReconciliationPass,
	type WorkPullRequestUpdate,
} from "@getkimchi/kimchi-bridge/reconcile"
import { lock } from "proper-lockfile"
import { readE2eSeam } from "../e2e-seam.js"
import { kimchiHostPorts } from "./host-ports.js"

const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000
/**
 * Test-only interval override, dead outside the test harness (readE2eSeam
 * gate). Evaluated once at module load so callers keep treating
 * RECONCILIATION_INTERVAL_MS as a value.
 */
export function resolveReconciliationIntervalMs(): number {
	const value = Number(readE2eSeam("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS") ?? Number.NaN)
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_RECONCILIATION_INTERVAL_MS
}
export const RECONCILIATION_INTERVAL_MS = resolveReconciliationIntervalMs()

const DEFAULT_FIRST_TICK_DELAY_MS = 5000
/**
 * A fresh supervisor holds its first pass for the startup window: the initial
 * ledger import and first delivery are the most expensive reconciliation
 * work, and running them synchronously at subscribe time races the
 * interactive startup path (keystroke echo stalls ~1.8 s into the session).
 * Later subscribers on the live supervisor still refresh immediately, and an
 * explicit requestWorkReconciliation() bypasses the delay as before.
 */
export function resolveFirstTickDelayMs(): number {
	// A present-but-blank value is unset (CI matrices export empty strings): Number("") is 0,
	// which would silently run the first pass at subscribe time.
	const raw = readE2eSeam("KIMCHI_E2E_FIRST_TICK_DELAY_MS")
	const value = raw !== undefined && raw.trim() !== "" ? Number(raw) : Number.NaN
	return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_FIRST_TICK_DELAY_MS
}
type ChannelKind = "pull-requests" | "costs" | "reporting"
/** Optional work with its own cancellation; unsubscribing waits only for that channel's pass. */
interface Channel {
	controller: AbortController
	running?: Promise<void>
}
interface Supervisor {
	subscribers: Set<ReconciliationSubscriber>
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	firstTick?: ReturnType<typeof setTimeout>
	hadPass?: boolean
	running?: Promise<void>
	requested?: boolean
	nextRepository?: string
	/** Continuation repair progress, carried across passes (PassResult.progress). */
	progress?: ContinuationProgress
	channels: Map<ChannelKind, Channel>
}
interface ReconciliationSubscriber {
	kind: "files" | ChannelKind
	onPullRequest?: (update: WorkPullRequestUpdate) => void
	onError?: (error: unknown) => void
	/** The reporting session's cwd for this pass; undefined skips the reporting channel. */
	reportingCwd?: () => string | undefined
}
const supervisors = new Map<string, Supervisor>()

async function scan(agentDir: string, owner: Supervisor): Promise<void> {
	const directory = join(agentDir, "work-attribution")
	await mkdir(directory, { recursive: true, mode: 0o700 })
	let compromised: Error | undefined
	const leaseLost = new AbortController()
	const signal = AbortSignal.any([owner.controller.signal, leaseLost.signal])
	let release: () => Promise<void>
	try {
		release = await lock(directory, {
			retries: 0,
			stale: 5000,
			update: 1000,
			onCompromised: (error) => {
				compromised = error
				leaseLost.abort()
			},
		})
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") return
		throw error
	}
	const assertLease = () => {
		signal.throwIfAborted()
		if (compromised) throw compromised
	}
	try {
		const files = [...owner.subscribers].some((subscriber) => subscriber.kind === "files")
		// The reporting channel runs for the reporting session's cwd, read fresh at
		// every pass the way the old onReport closure read its captured context.
		const reportingCwd = owner.channels.has("reporting")
			? [...owner.subscribers].find((subscriber) => subscriber.kind === "reporting")?.reportingCwd?.()
			: undefined
		const input: PassInput = {
			files: files || undefined,
			pullRequests: owner.channels.has("pull-requests")
				? {
						onUpdate: (update) => {
							for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
						},
						onError: (error) => reportError(owner, error),
						signal: owner.channels.get("pull-requests")?.controller.signal,
					}
				: undefined,
			costs: owner.channels.has("costs") ? { signal: owner.channels.get("costs")?.controller.signal } : undefined,
			reporting:
				reportingCwd !== undefined
					? {
							cwd: reportingCwd,
							signal: owner.channels.get("reporting")?.controller.signal,
						}
					: undefined,
			nextRepository: owner.nextRepository,
			// Cross-pass continuation progress: the pass materializes it once and returns
			// it in PassResult.progress, exactly how the old scan() body threaded `owner`.
			progress: owner.progress,
		}
		const result = await runReconciliationPass(input, kimchiHostPorts(), { signal, assertLease })
		owner.nextRepository = result.nextRepository
		owner.progress = result.progress
	} finally {
		if (!compromised) await release()
	}
}

function reportError(owner: Supervisor, error: unknown): void {
	let reported = false
	for (const subscriber of owner.subscribers) {
		if (!subscriber.onError) continue
		subscriber.onError(error)
		reported = true
	}
	if (!reported) debug("Reconciliation unavailable:", error)
}

/** Cheap local refresh: surface durable pull-request updates the session already holds. */
function drainDurableUpdates(agentDir: string, owner: Supervisor): void {
	if (owner.controller.signal.aborted) return
	try {
		if (owner.channels.has("pull-requests"))
			for (const update of readWorkPullRequestUpdates(agentDir))
				for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
	} catch (error) {
		reportError(owner, error)
	}
}

function tick(agentDir: string, owner: Supervisor): void {
	if (owner.controller.signal.aborted) return
	// Every process can display durable results, even while another process owns
	// the lease for Git and GitHub queries.
	drainDurableUpdates(agentDir, owner)
	if (owner.running) return
	owner.hadPass = true
	// A pass has run: the delayed first tick is moot. Clearing it (not just guarding it) lets a
	// subscriber joining now tick immediately — the startup window is over in substance.
	if (owner.firstTick !== undefined) {
		clearTimeout(owner.firstTick)
		owner.firstTick = undefined
	}
	owner.running = scan(agentDir, owner)
		.catch((error) => {
			if (!owner.controller.signal.aborted) debug("Reconciliation unavailable: %o", error)
		})
		.finally(() => {
			owner.running = undefined
			if (owner.requested) {
				owner.requested = false
				tick(agentDir, owner)
			}
		})
}

/** Refresh existing subscribers now, or once the current leased pass finishes. */
export function requestWorkReconciliation(): void {
	const agentDir = resolve(getAgentDir())
	const owner = supervisors.get(agentDir)
	if (!owner || owner.controller.signal.aborted) return
	if (owner.running) owner.requested = true
	else tick(agentDir, owner)
}

/** One optional worker per harness directory. Local children never subscribe. */
function subscribeReconciliation(subscriber: ReconciliationSubscriber): () => Promise<void> {
	const agentDir = resolve(getAgentDir())
	let owner = supervisors.get(agentDir)
	if (!owner || owner.controller.signal.aborted) {
		owner = { subscribers: new Set(), controller: new AbortController(), channels: new Map() }
		supervisors.set(agentDir, owner)
		const current = owner
		current.timer = setInterval(() => tick(agentDir, current), RECONCILIATION_INTERVAL_MS)
		current.timer.unref()
		const delay = resolveFirstTickDelayMs()
		if (delay > 0) {
			current.firstTick = setTimeout(() => {
				current.firstTick = undefined
				// An explicit requestWorkReconciliation() or interval tick may have
				// already run a pass inside the window; the delayed one is then moot.
				if (!current.hadPass) tick(agentDir, current)
			}, delay)
			current.firstTick.unref()
		}
	}
	const subscription = { ...subscriber }
	owner.subscribers.add(subscription)
	if (subscriber.kind !== "files" && !owner.channels.has(subscriber.kind))
		owner.channels.set(subscriber.kind, { controller: new AbortController() })
	if (owner.firstTick === undefined || owner.hadPass) tick(agentDir, owner)
	// A subscriber joining inside the delayed first-pass window — before any pass has run — skips
	// the expensive scan (that is the point of the delay) but still receives the durable pull-request
	// updates the session already knows about. Once a pass has run (explicit request or otherwise)
	// the startup window is over in substance: the joiner ticks like any later subscriber.
	else drainDurableUpdates(agentDir, owner)
	const current = owner
	let stopped = false
	return async () => {
		if (stopped) return
		stopped = true
		current.subscribers.delete(subscription)
		const pending: (Promise<void> | undefined)[] = []
		for (const [kind, channel] of current.channels)
			if (![...current.subscribers].some((entry) => entry.kind === kind)) {
				channel.controller.abort()
				current.channels.delete(kind)
				pending.push(channel.running)
			}
		if (current.subscribers.size) {
			await Promise.all(pending)
			return
		}
		clearInterval(current.timer)
		if (current.firstTick !== undefined) {
			clearTimeout(current.firstTick)
			current.firstTick = undefined
		}
		current.controller.abort()
		await current.running
		if (supervisors.get(agentDir) === current) supervisors.delete(agentDir)
	}
}

/** Work tracking only reconciles local Git history. */
export function subscribeFileReconciliation(): () => Promise<void> {
	return subscribeReconciliation({ kind: "files" })
}
/** PR discovery is optional and owns its network subscription separately. */
export function subscribePullRequestReconciliation(subscriber: {
	onPullRequest: (update: WorkPullRequestUpdate) => void
	onError?: (error: unknown) => void
}): () => Promise<void> {
	return subscribeReconciliation({ ...subscriber, kind: "pull-requests" })
}

/** Price lookups share the timer and lease; only main work-tracking sessions subscribe. */
export function subscribeCostReconciliation(): () => Promise<void> {
	return subscribeReconciliation({ kind: "costs" })
}
/**
 * An optional extension supplies delivery; work tracking has no reporting dependency.
 * The cwd getter is read fresh at every pass: it is the reporting session's
 * cwd, replacing the old onReport closure that read its captured context.
 */
export function subscribeReportingReconciliation(reportingCwd: () => string | undefined): () => Promise<void> {
	return subscribeReconciliation({ kind: "reporting", reportingCwd })
}
