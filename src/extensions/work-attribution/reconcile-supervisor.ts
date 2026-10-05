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
import { knownTransitionRepositories, reconcileRepositoryTransitions } from "./file-transitions.js"

export const RECONCILIATION_INTERVAL_MS = 30_000
const PASS_BUDGET_MS = 3000
const debug = debuglog("kimchi:work-attribution")
interface Supervisor {
	subscribers: Set<ReconciliationSubscriber>
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	running?: Promise<void>
	nextRepository?: string
	pullRequestController?: AbortController
	pullRequestRunning?: Promise<void>
}
interface ReconciliationSubscriber {
	kind: "files" | "pull-requests"
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
	tick(agentDir, owner)
	const current = owner
	let stopped = false
	return async () => {
		if (stopped) return
		stopped = true
		current.subscribers.delete(subscription)
		let pendingPullRequests: Promise<void> | undefined
		if (![...current.subscribers].some((entry) => entry.kind === "pull-requests")) {
			current.pullRequestController?.abort()
			current.pullRequestController = undefined
			pendingPullRequests = current.pullRequestRunning
		}
		if (current.subscribers.size) {
			await pendingPullRequests
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
