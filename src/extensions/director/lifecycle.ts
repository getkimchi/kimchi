import { createDirectorState, type DirectorRunState } from "./plan.js"
import type { DirectorStore } from "./state.js"

const ACTIVE_WORKER_STATUSES = new Set(["queued", "running", "reconnecting"])
const TERMINAL_WORKER_STATUSES = new Set(["completed", "stopped", "aborted", "steered", "error", "failed"])

export interface DirectorWorkerSnapshot {
	id: string
	type: string
	description: string
	status: string
	remote?: boolean
	result?: string
	error?: string
	startedAt: number
	completedAt?: number
}

export interface DirectorWorkerGateway {
	list(): readonly DirectorWorkerSnapshot[]
	abort(id: string): boolean
}

export class DirectorLifecycleError extends Error {
	constructor(
		readonly code:
			| "director-active"
			| "orchestration-active"
			| "workers-active"
			| "worker-abort-failed"
			| "verification-required"
			| "tasks-open"
			| "reconciliation-required"
			| "director-inactive"
			| "worker-not-uncertain",
		message: string,
	) {
		super(message)
		this.name = "DirectorLifecycleError"
	}
}

function currentState(store: DirectorStore): DirectorRunState {
	const state = store.read()
	if (!state || state.status === "inactive")
		throw new DirectorLifecycleError("director-inactive", "Director is not active")
	return state
}

function activeWorkers(gateway: DirectorWorkerGateway): DirectorWorkerSnapshot[] {
	return gateway.list().filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status))
}

export function activateDirector(
	store: DirectorStore,
	options: {
		objective: string
		runId: string
		gateway: DirectorWorkerGateway
		otherOrchestrationActive?: () => boolean
	},
): DirectorRunState {
	const existing = store.read()
	if (existing && existing.status !== "inactive") {
		throw new DirectorLifecycleError(
			"director-active",
			"Director is already active; steer it instead of replacing its objective",
		)
	}
	if (options.otherOrchestrationActive?.()) {
		throw new DirectorLifecycleError(
			"orchestration-active",
			"Another orchestration runtime is active; finish or hand it off first",
		)
	}
	const workers = activeWorkers(options.gateway)
	if (workers.length > 0) {
		throw new DirectorLifecycleError(
			"workers-active",
			`Join, stop, or hand off active workers before starting Director: ${workers.map((worker) => `${worker.id} (${worker.status})`).join(", ")}`,
		)
	}
	if (!options.objective.trim() || !options.runId.trim()) throw new Error("Director objective and runId are required")
	return store.commit(createDirectorState(options.objective, options.runId), existing?.revision ?? 0)
}

export function assertDirectorCanSpawn(store: DirectorStore): void {
	const state = currentState(store)
	const uncertain = Object.values(state.plan.workers).filter((worker) => worker.disposition === "uncertain")
	if (uncertain.length > 0) {
		throw new DirectorLifecycleError(
			"reconciliation-required",
			`Reconcile stale workers before new delegation: ${uncertain.map((worker) => worker.id).join(", ")}`,
		)
	}
}

export function finishDirector(
	store: DirectorStore,
	options: {
		outcome: "completed" | "blocked" | "cancelled"
		verificationSummary?: string
		artifactPaths?: string[]
		gateway: DirectorWorkerGateway
		handoff?: boolean
	},
): DirectorRunState {
	const current = currentState(store)
	assertDirectorCanSpawn(store)
	const live = activeWorkers(options.gateway)
	if (live.length > 0 && !options.handoff && options.outcome !== "cancelled") {
		throw new DirectorLifecycleError(
			"workers-active",
			`Workers are still active: ${live.map((worker) => worker.id).join(", ")}`,
		)
	}
	if (options.outcome === "completed") {
		if (!options.verificationSummary?.trim()) {
			throw new DirectorLifecycleError("verification-required", "A verification summary is required before completion")
		}
		const incomplete = current.plan.tasks.filter((task) => task.status !== "completed" && task.status !== "skipped")
		if (incomplete.length > 0) {
			throw new DirectorLifecycleError(
				"tasks-open",
				`Complete or explicitly skip tasks before finishing: ${incomplete.map((task) => task.id).join(", ")}`,
			)
		}
	}

	if (live.length > 0 && options.handoff) {
		for (const worker of live) {
			if (!current.plan.workers[worker.id])
				throw new DirectorLifecycleError("workers-active", `Untracked worker '${worker.id}' cannot be handed off`)
			current.plan.workers[worker.id].disposition = "handed-off"
		}
	} else if (options.outcome === "cancelled") {
		const untracked = live.filter((worker) => !current.plan.workers[worker.id])
		if (untracked.length > 0) {
			throw new DirectorLifecycleError(
				"workers-active",
				`Untracked workers cannot be stopped: ${untracked.map((worker) => worker.id).join(", ")}`,
			)
		}
		const inconsistent = live.filter(
			(worker) => !["owned", "handed-off"].includes(current.plan.workers[worker.id].disposition),
		)
		if (inconsistent.length > 0) {
			throw new DirectorLifecycleError(
				"workers-active",
				`Live workers require reconciliation before stopping: ${inconsistent.map((worker) => `${worker.id} (${current.plan.workers[worker.id].disposition})`).join(", ")}`,
			)
		}
		for (const worker of live) {
			if (current.plan.workers[worker.id].disposition !== "owned") continue
			if (!options.gateway.abort(worker.id)) {
				throw new DirectorLifecycleError("worker-abort-failed", `Failed to abort worker '${worker.id}'`)
			}
			current.plan.workers[worker.id].disposition = "stopped"
		}
	}
	if (options.outcome === "completed" || options.outcome === "blocked") {
		current.plan.verification.push({
			summary: options.verificationSummary?.trim() || "Director stopped without successful completion",
			outcome: options.outcome,
			artifactPaths: [...new Set([...(options.artifactPaths ?? []), ...current.plan.artifactPaths])],
		})
	}
	return store.commit({ ...current, status: "inactive" }, current.revision)
}

export function reconcileDirectorResume(
	store: DirectorStore,
	gateway: DirectorWorkerGateway,
): DirectorRunState | undefined {
	const current = store.read()
	if (!current || current.status === "inactive") return current
	let changed = false
	for (const worker of Object.values(current.plan.workers)) {
		if (worker.disposition !== "owned") continue
		const live = gateway.list().find((candidate) => candidate.id === worker.id)
		if (live && ACTIVE_WORKER_STATUSES.has(live.status)) {
			changed ||= worker.status !== live.status
			worker.status = live.status
			continue
		}
		if (live && TERMINAL_WORKER_STATUSES.has(live.status)) {
			worker.status = live.status
			worker.disposition = live.status === "completed" || live.status === "steered" ? "joined" : "stopped"
			worker.result = live.result ?? worker.result
			worker.error = live.error ?? worker.error
			changed = true
			continue
		}
		if (ACTIVE_WORKER_STATUSES.has(worker.status)) {
			worker.disposition = "uncertain"
			worker.recoveryNote = "No matching live worker was found after session resume; resolve before new delegation"
			changed = true
		}
	}
	return changed ? store.commit(current, current.revision) : current
}

export function reconcileDirectorWorker(
	store: DirectorStore,
	options: { workerId: string; disposition: "joined" | "stopped" | "handed-off"; note?: string },
): DirectorRunState {
	const current = currentState(store)
	const worker = current.plan.workers[options.workerId]
	if (worker?.disposition !== "uncertain") {
		throw new DirectorLifecycleError(
			"worker-not-uncertain",
			`Worker '${options.workerId}' does not require reconciliation`,
		)
	}
	worker.disposition = options.disposition
	worker.status =
		options.disposition === "joined" ? "completed" : options.disposition === "stopped" ? "stopped" : worker.status
	worker.recoveryNote = options.note
	return store.commit(current, current.revision)
}
