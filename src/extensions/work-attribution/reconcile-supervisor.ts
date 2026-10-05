import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { debuglog } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { knownTransitionRepositories, reconcileRepositoryTransitions } from "./file-transitions.js"

export const RECONCILIATION_INTERVAL_MS = 30_000
const PASS_BUDGET_MS = 3000
const debug = debuglog("kimchi:work-attribution")
interface Supervisor {
	subscribers: number
	controller: AbortController
	timer?: ReturnType<typeof setInterval>
	running?: Promise<void>
	nextRepository?: string
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
		if (error !== exhausted && !signal.aborted) throw error
	} finally {
		if (!compromised) await release()
	}
}

function tick(agentDir: string, owner: Supervisor): void {
	if (owner.running || owner.controller.signal.aborted) return
	owner.running = scan(agentDir, owner)
		.catch((error) => {
			if (!owner.controller.signal.aborted) debug("Reconciliation unavailable: %o", error)
		})
		.finally(() => {
			owner.running = undefined
		})
}

/** One optional worker per harness directory. Local children never subscribe. */
export function subscribeFileReconciliation(): () => Promise<void> {
	const agentDir = resolve(getAgentDir())
	let owner = supervisors.get(agentDir)
	if (!owner || owner.controller.signal.aborted) {
		owner = { subscribers: 0, controller: new AbortController() }
		supervisors.set(agentDir, owner)
		const current = owner
		current.timer = setInterval(() => tick(agentDir, current), RECONCILIATION_INTERVAL_MS)
		current.timer.unref()
	}
	owner.subscribers++
	tick(agentDir, owner)
	const current = owner
	let stopped = false
	return async () => {
		if (stopped) return
		stopped = true
		if (--current.subscribers) return
		clearInterval(current.timer)
		current.controller.abort()
		await current.running
		if (supervisors.get(agentDir) === current) supervisors.delete(agentDir)
	}
}
