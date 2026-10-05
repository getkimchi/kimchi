import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { debuglog } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import {
	readWorkPullRequestUpdates,
	reconcileWorkPullRequests,
	type WorkPullRequestUpdate,
} from "../pull-request-status/pull-requests.js"
import { reconcileWorkCosts } from "./cost-sync.js"
import { knownTransitionRepositories, reconcileRepositoryTransitions } from "./file-transitions.js"
import { reconcileWorkContinuations } from "./links.js"

export const RECONCILIATION_INTERVAL_MS = 30_000
const PASS_BUDGET_MS = 3000
const debug = debuglog("kimchi:work-attribution")
interface Supervisor {
	subscribers: Set<ReconciliationSubscriber>
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	running?: Promise<void>
	nextRepository?: string
	nextContinuation?: string
	pullRequestController?: AbortController
	pullRequestRunning?: Promise<void>
	costController?: AbortController
	costRunning?: Promise<void>
	reportingController?: AbortController
	reportingRunning?: Promise<void>
}
interface ReconciliationSubscriber {
	kind: "files" | "pull-requests" | "costs" | "reporting"
	onReport?: (agentDir: string, signal: AbortSignal, assertLease: () => void) => Promise<void>
	onPullRequest?: (update: WorkPullRequestUpdate) => void
	onError?: (error: unknown) => void
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
	const deadline = Date.now() + PASS_BUDGET_MS
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
		const controller = owner.pullRequestController
		if (controller && !controller.signal.aborted) {
			const prSignal = AbortSignal.any([signal, controller.signal])
			const assertPullRequestLease = () => {
				assertLease()
				prSignal.throwIfAborted()
			}
			const pending = reconcileWorkPullRequests(agentDir, prSignal, assertPullRequestLease, (update) => {
				for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
			}).catch((error) => {
				if (!prSignal.aborted) reportError(owner, error)
			})
			owner.pullRequestRunning = pending
			try {
				await pending
			} finally {
				if (owner.pullRequestRunning === pending) owner.pullRequestRunning = undefined
			}
		}
		const costController = owner.costController
		if (costController && !costController.signal.aborted) {
			const costSignal = AbortSignal.any([signal, costController.signal])
			const pending = reconcileWorkCosts(agentDir, costSignal, () => {
				assertLease()
				costSignal.throwIfAborted()
			}).catch((error) => {
				if (!costSignal.aborted) debug("Could not reconcile costs: %o", error)
			})
			owner.costRunning = pending
			try {
				await pending
			} finally {
				if (owner.costRunning === pending) owner.costRunning = undefined
			}
		}
		// Historical repair is local and has its own budget; PR and billing work run first.
		if ([...owner.subscribers].some((subscriber) => subscriber.kind === "files")) {
			try {
				await reconcileWorkContinuations(agentDir, signal, assertLease, owner)
			} catch (error) {
				if (!signal.aborted) debug("Could not reconcile work continuations: %o", error)
			}
		}
		const reporting = [...owner.subscribers].find((subscriber) => subscriber.kind === "reporting")
		const reportingController = owner.reportingController
		if (reporting?.onReport && reportingController && !reportingController.signal.aborted) {
			const reportingSignal = AbortSignal.any([signal, reportingController.signal])
			const pending = reporting
				.onReport(agentDir, reportingSignal, () => {
					assertLease()
					reportingSignal.throwIfAborted()
				})
				.catch((error) => {
					if (!reportingSignal.aborted) debug("Could not report PR costs: %o", error)
				})
			owner.reportingRunning = pending
			try {
				await pending
			} finally {
				if (owner.reportingRunning === pending) owner.reportingRunning = undefined
			}
		}
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
	if (!reported) console.warn("[work-attribution] Reconciliation unavailable:", error)
}

function tick(agentDir: string, owner: Supervisor): void {
	if (owner.controller.signal.aborted) return
	// Every process can display durable results, even while another process owns
	// the lease for Git and GitHub queries.
	try {
		if (owner.pullRequestController && !owner.pullRequestController.signal.aborted)
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
		})
}

/** One optional worker per harness directory. Local children never subscribe. */
function subscribeReconciliation(subscriber: ReconciliationSubscriber): () => Promise<void> {
	const agentDir = resolve(getAgentDir())
	let owner = supervisors.get(agentDir)
	if (!owner || owner.controller.signal.aborted) {
		owner = { subscribers: new Set(), controller: new AbortController() }
		supervisors.set(agentDir, owner)
		const current = owner
		current.timer = setInterval(() => tick(agentDir, current), RECONCILIATION_INTERVAL_MS)
		current.timer.unref()
	}
	const subscription = { ...subscriber }
	owner.subscribers.add(subscription)
	if (
		subscriber.kind === "pull-requests" &&
		(!owner.pullRequestController || owner.pullRequestController.signal.aborted)
	)
		owner.pullRequestController = new AbortController()
	if (subscriber.kind === "costs" && (!owner.costController || owner.costController.signal.aborted))
		owner.costController = new AbortController()
	if (subscriber.kind === "reporting" && (!owner.reportingController || owner.reportingController.signal.aborted))
		owner.reportingController = new AbortController()
	tick(agentDir, owner)
	const current = owner
	let stopped = false
	return async () => {
		if (stopped) return
		stopped = true
		current.subscribers.delete(subscription)
		let pendingPullRequests: Promise<void> | undefined
		let pendingCosts: Promise<void> | undefined
		let pendingReporting: Promise<void> | undefined
		if (![...current.subscribers].some((entry) => entry.kind === "pull-requests")) {
			current.pullRequestController?.abort()
			current.pullRequestController = undefined
			pendingPullRequests = current.pullRequestRunning
		}
		if (![...current.subscribers].some((entry) => entry.kind === "costs")) {
			current.costController?.abort()
			current.costController = undefined
			pendingCosts = current.costRunning
		}
		if (![...current.subscribers].some((entry) => entry.kind === "reporting")) {
			current.reportingController?.abort()
			current.reportingController = undefined
			pendingReporting = current.reportingRunning
		}
		if (current.subscribers.size) {
			await Promise.all([pendingPullRequests, pendingCosts, pendingReporting])
			return
		}
		clearInterval(current.timer)
		current.controller.abort()
		await current.running
		if (supervisors.get(agentDir) === current) supervisors.delete(agentDir)
	}
}

/** Work tracking only reconciles local Git history. */
export function subscribeFileReconciliation(
	subscriber: Pick<ReconciliationSubscriber, "onError"> = {},
): () => Promise<void> {
	return subscribeReconciliation({ ...subscriber, kind: "files" })
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
