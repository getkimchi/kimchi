import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { knownTransitionRepositories, reconcileRepositoryTransitions } from "./file-transitions.js"
import { readWorkPullRequestUpdates, reconcileWorkPullRequests, type WorkPullRequestUpdate } from "./pull-requests.js"

export const RECONCILIATION_INTERVAL_MS = 30_000
const PASS_BUDGET_MS = 3000
interface Supervisor {
	subscribers: Set<ReconciliationSubscriber>
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	running?: Promise<void>
	nextRepository?: string
}
interface ReconciliationSubscriber {
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
					reportError(owner, error)
				}
			}
		} catch (error) {
			if (error !== exhausted && !signal.aborted) reportError(owner, error)
		}
		// Network lookup has its own deadline. A slow local repository must not starve it,
		// and Bash-only commits have no transition repository to visit above.
		assertLease()
		await reconcileWorkPullRequests(agentDir, signal, assertLease, (update) => {
			for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
		})
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
		for (const update of readWorkPullRequestUpdates(agentDir))
			for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update)
	} catch (error) {
		reportError(owner, error)
	}
	if (owner.running) return
	owner.running = scan(agentDir, owner)
		.catch((error) => {
			if (!owner.controller.signal.aborted) reportError(owner, error)
		})
		.finally(() => {
			owner.running = undefined
		})
}

/** One optional worker per harness directory. Local children never subscribe. */
export function subscribeFileReconciliation(subscriber: ReconciliationSubscriber = {}): () => Promise<void> {
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
	tick(agentDir, owner)
	const current = owner
	let stopped = false
	return async () => {
		if (stopped) return
		stopped = true
		current.subscribers.delete(subscription)
		if (current.subscribers.size) return
		clearInterval(current.timer)
		current.controller.abort()
		await current.running
		if (supervisors.get(agentDir) === current) supervisors.delete(agentDir)
	}
}
