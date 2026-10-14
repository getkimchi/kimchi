import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import {
	readWorkPullRequestUpdates,
	reconcileWorkPullRequests,
	type WorkPullRequestUpdate,
} from "../pull-request-status/pull-requests.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { reconcileWorkCosts } from "./cost-sync.js"
import { debugWorkAttribution as debug } from "./diagnostics.js"
import { knownTransitionRepositories, reconcileRepositoryTransitions } from "./file-transitions.js"
import { type ContinuationProgress, reconcileWorkContinuations } from "./links.js"

export const RECONCILIATION_INTERVAL_MS = 30_000
const PASS_BUDGET_MS = 3000
type ChannelKind = "pull-requests" | "costs" | "reporting"
/** Optional work with its own cancellation; unsubscribing waits only for that channel's pass. */
interface Channel {
	controller: AbortController
	running?: Promise<void>
}
interface Supervisor extends ContinuationProgress {
	subscribers: Set<ReconciliationSubscriber>
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	running?: Promise<void>
	requested?: boolean
	nextRepository?: string
	channels: Map<ChannelKind, Channel>
}
interface ReconciliationSubscriber {
	kind: "files" | ChannelKind
	onReport?: (agentDir: string, signal: AbortSignal, assertLease: () => void) => Promise<void>
	onPullRequest?: (update: WorkPullRequestUpdate) => void
	onError?: (error: unknown) => void
}
const supervisors = new Map<string, Supervisor>()

async function runChannel(
	owner: Supervisor,
	kind: ChannelKind,
	leaseSignal: AbortSignal,
	assertLease: () => void,
	run: (signal: AbortSignal, assertLease: () => void) => Promise<void>,
	onError: (error: unknown) => void,
): Promise<void> {
	const channel = owner.channels.get(kind)
	if (!channel || channel.controller.signal.aborted) return
	const signal = AbortSignal.any([leaseSignal, channel.controller.signal])
	const pending = run(signal, () => {
		assertLease()
		signal.throwIfAborted()
	}).catch((error) => {
		if (!signal.aborted) onError(error)
	})
	channel.running = pending
	try {
		await pending
	} finally {
		if (channel.running === pending) channel.running = undefined
	}
}

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
	const deadline = Date.now() + PASS_BUDGET_MS
	trackPRCostMetric({ kind: "reconciliation" })
	const exhausted = new Error("Work attribution reconciliation time limit exceeded")
	const checkBudget = () => {
		assertLease()
		if (Date.now() > deadline) throw exhausted
	}
	try {
		if ([...owner.subscribers].some((subscriber) => subscriber.kind === "files")) {
			try {
				const repositories = await knownTransitionRepositories(checkBudget)
				const start = Math.max(0, repositories.indexOf(owner.nextRepository ?? ""))
				for (let offset = 0; offset < repositories.length; offset++) {
					checkBudget()
					const index = (start + offset) % repositories.length
					// Move on after a slow/broken repository; its own checkpoints preserve partial progress.
					owner.nextRepository = repositories[(index + 1) % repositories.length]
					try {
						await reconcileRepositoryTransitions(repositories[index], signal, checkBudget, assertLease)
					} catch (error) {
						if (error === exhausted || signal.aborted) throw error
						debug("Could not reconcile repository %s: %o", repositories[index], error)
					}
				}
			} catch (error) {
				if (error !== exhausted && !signal.aborted) debug("Could not discover repositories: %o", error)
			}
		}
		// Network lookup has its own deadline. A slow local repository must not starve it,
		// and Bash-only commits have no transition repository to visit above.
		await runChannel(
			owner,
			"pull-requests",
			signal,
			assertLease,
			(channelSignal, assertChannel) =>
				reconcileWorkPullRequests(agentDir, channelSignal, assertChannel, (update) => {
					for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
				}),
			(error) => reportError(owner, error),
		)
		await runChannel(
			owner,
			"costs",
			signal,
			assertLease,
			(channelSignal, assertChannel) => reconcileWorkCosts(agentDir, channelSignal, assertChannel),
			(error) => debug("Could not reconcile costs: %o", error),
		)
		// Historical repair is local and has its own budget; PR and billing work run first.
		if ([...owner.subscribers].some((subscriber) => subscriber.kind === "files")) {
			try {
				await reconcileWorkContinuations(agentDir, signal, assertLease, owner)
			} catch (error) {
				if (!signal.aborted) debug("Could not reconcile work continuations: %o", error)
			}
		}
		const report = [...owner.subscribers].find((subscriber) => subscriber.kind === "reporting")?.onReport
		if (report)
			await runChannel(
				owner,
				"reporting",
				signal,
				assertLease,
				(channelSignal, assertChannel) => report(agentDir, channelSignal, assertChannel),
				(error) => debug("Could not report PR costs: %o", error),
			)
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

function tick(agentDir: string, owner: Supervisor): void {
	if (owner.controller.signal.aborted) return
	// Every process can display durable results, even while another process owns
	// the lease for Git and GitHub queries.
	try {
		if (owner.channels.has("pull-requests"))
			for (const update of readWorkPullRequestUpdates(agentDir))
				for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
	} catch (error) {
		reportError(owner, error)
	}
	if (owner.running) return
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
	}
	const subscription = { ...subscriber }
	owner.subscribers.add(subscription)
	if (subscriber.kind !== "files" && !owner.channels.has(subscriber.kind))
		owner.channels.set(subscriber.kind, { controller: new AbortController() })
	tick(agentDir, owner)
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
/** An optional extension supplies delivery; work tracking has no reporting dependency. */
export function subscribeReportingReconciliation(
	onReport: NonNullable<ReconciliationSubscriber["onReport"]>,
): () => Promise<void> {
	return subscribeReconciliation({ kind: "reporting", onReport })
}
