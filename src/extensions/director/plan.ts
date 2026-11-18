export type DirectorModeStatus = "active" | "completing" | "inactive"
export type DirectorTaskStatus = "pending" | "running" | "completed" | "blocked" | "skipped"
export type DirectorWorkerDisposition = "owned" | "handed-off" | "stopped" | "joined" | "uncertain"

export interface DirectorTask {
	id: string
	title: string
	status: DirectorTaskStatus
	dependsOn: string[]
	owner?: string
	acceptWhen?: string
}

export interface DirectorWorkerState {
	id: string
	type: string
	description: string
	status: string
	disposition: DirectorWorkerDisposition
	result?: string
	error?: string
	recoveryNote?: string
	backgrounded?: boolean
	compactionCount?: number
	artifactPaths: string[]
}

export interface DirectorPlan {
	tasks: DirectorTask[]
	currentPhase: string
	decisions: Array<{ id: string; text: string; rationale?: string }>
	contracts: Array<{ id: string; text: string; version: number }>
	assumptions: string[]
	ownership: Array<{ area: string; workerId?: string }>
	workers: Record<string, DirectorWorkerState>
	verification: Array<{ summary: string; outcome: string; artifactPaths: string[] }>
	openQuestions: string[]
	artifactPaths: string[]
}

export interface DirectorRunState {
	status: DirectorModeStatus
	runId: string
	objective: string
	plan: DirectorPlan
	revision: number
	updatedAt: string
}

const TASK_STATUSES = new Set<DirectorTaskStatus>(["pending", "running", "completed", "blocked", "skipped"])
const WORKER_DISPOSITIONS = new Set<DirectorWorkerDisposition>([
	"owned",
	"handed-off",
	"stopped",
	"joined",
	"uncertain",
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, allowEmpty = false): asserts value is string {
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
		throw new Error(`Invalid Director plan: ${field} must be a non-empty string`)
	}
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`Invalid Director plan: ${field} must be a string array`)
	}
}

function requireOptionalString(value: unknown, field: string): void {
	if (value !== undefined) requireString(value, field)
}

function requireArray(value: unknown, field: string): asserts value is unknown[] {
	if (!Array.isArray(value)) throw new Error(`Invalid Director plan: ${field} must be an array`)
}

export function createDirectorState(
	objective: string,
	runId: string,
	updatedAt = new Date().toISOString(),
): DirectorRunState {
	return {
		status: "active",
		runId,
		objective,
		revision: 0,
		updatedAt,
		plan: {
			tasks: [],
			currentPhase: "planning",
			decisions: [],
			contracts: [],
			assumptions: [],
			ownership: [],
			workers: {},
			verification: [],
			openQuestions: [],
			artifactPaths: [],
		},
	}
}

export function assertValidDirectorPlan(value: unknown): asserts value is DirectorPlan {
	if (!isRecord(value)) throw new Error("Invalid Director plan: expected an object")
	requireArray(value.tasks, "tasks")
	requireString(value.currentPhase, "currentPhase")
	requireArray(value.decisions, "decisions")
	requireArray(value.contracts, "contracts")
	requireStringArray(value.assumptions, "assumptions")
	requireArray(value.ownership, "ownership")
	if (!isRecord(value.workers)) throw new Error("Invalid Director plan: workers must be an object")
	requireArray(value.verification, "verification")
	requireStringArray(value.openQuestions, "openQuestions")
	requireStringArray(value.artifactPaths, "artifactPaths")

	const taskIds = new Set<string>()
	for (const [index, task] of value.tasks.entries()) {
		if (!isRecord(task)) throw new Error(`Invalid Director plan: tasks[${index}] must be an object`)
		requireString(task.id, `tasks[${index}].id`)
		if (taskIds.has(task.id)) throw new Error(`Invalid Director plan: duplicate task id '${task.id}'`)
		taskIds.add(task.id)
		requireString(task.title, `tasks[${index}].title`)
		requireString(task.status, `tasks[${index}].status`)
		if (!TASK_STATUSES.has(task.status as DirectorTaskStatus)) {
			throw new Error(`Invalid Director plan: unsupported task status '${task.status}'`)
		}
		requireStringArray(task.dependsOn, `tasks[${index}].dependsOn`)
		requireOptionalString(task.owner, `tasks[${index}].owner`)
		requireOptionalString(task.acceptWhen, `tasks[${index}].acceptWhen`)
	}

	const byId = new Map<string, DirectorTask>()
	for (const task of value.tasks as DirectorTask[]) byId.set(task.id, task)
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Invalid Director plan: cyclic dependency involving '${id}'`)
		if (visited.has(id)) return
		const task = byId.get(id)
		if (!task) throw new Error(`Invalid Director plan: unknown dependency '${id}'`)
		visiting.add(id)
		for (const dependency of task.dependsOn) visit(dependency)
		visiting.delete(id)
		visited.add(id)
	}
	for (const id of byId.keys()) visit(id)

	for (const [index, decision] of value.decisions.entries()) {
		if (!isRecord(decision)) throw new Error(`Invalid Director plan: decisions[${index}] must be an object`)
		requireString(decision.id, `decisions[${index}].id`)
		requireString(decision.text, `decisions[${index}].text`)
		requireOptionalString(decision.rationale, `decisions[${index}].rationale`)
	}
	for (const [index, contract] of value.contracts.entries()) {
		if (!isRecord(contract)) throw new Error(`Invalid Director plan: contracts[${index}] must be an object`)
		requireString(contract.id, `contracts[${index}].id`)
		requireString(contract.text, `contracts[${index}].text`)
		if (!Number.isInteger(contract.version) || (contract.version as number) < 1) {
			throw new Error(`Invalid Director plan: contracts[${index}].version must be a positive integer`)
		}
	}
	for (const [index, ownership] of value.ownership.entries()) {
		if (!isRecord(ownership)) throw new Error(`Invalid Director plan: ownership[${index}] must be an object`)
		requireString(ownership.area, `ownership[${index}].area`)
		requireOptionalString(ownership.workerId, `ownership[${index}].workerId`)
	}
	for (const [id, worker] of Object.entries(value.workers)) {
		if (!isRecord(worker)) throw new Error(`Invalid Director plan: worker '${id}' must be an object`)
		requireString(worker.id, `workers.${id}.id`)
		if (worker.id !== id) throw new Error(`Invalid Director plan: worker key '${id}' does not match its id`)
		requireString(worker.type, `workers.${id}.type`)
		requireString(worker.description, `workers.${id}.description`)
		requireString(worker.status, `workers.${id}.status`)
		requireString(worker.disposition, `workers.${id}.disposition`)
		if (!WORKER_DISPOSITIONS.has(worker.disposition as DirectorWorkerDisposition)) {
			throw new Error(`Invalid Director plan: unsupported worker disposition '${worker.disposition}'`)
		}
		requireOptionalString(worker.result, `workers.${id}.result`)
		requireOptionalString(worker.error, `workers.${id}.error`)
		requireOptionalString(worker.recoveryNote, `workers.${id}.recoveryNote`)
		if (
			worker.compactionCount !== undefined &&
			(typeof worker.compactionCount !== "number" ||
				!Number.isInteger(worker.compactionCount) ||
				worker.compactionCount < 0)
		) {
			throw new Error(`Invalid Director plan: workers.${id}.compactionCount must be a non-negative integer`)
		}
		if (worker.backgrounded !== undefined && typeof worker.backgrounded !== "boolean") {
			throw new Error(`Invalid Director plan: workers.${id}.backgrounded must be a boolean`)
		}
		requireStringArray(worker.artifactPaths, `workers.${id}.artifactPaths`)
	}
	for (const [index, verification] of value.verification.entries()) {
		if (!isRecord(verification)) throw new Error(`Invalid Director plan: verification[${index}] must be an object`)
		requireString(verification.summary, `verification[${index}].summary`)
		requireString(verification.outcome, `verification[${index}].outcome`)
		requireStringArray(verification.artifactPaths, `verification[${index}].artifactPaths`)
	}
}

export function assertValidDirectorRunState(value: unknown): asserts value is DirectorRunState {
	if (!isRecord(value)) throw new Error("Invalid Director run state: expected an object")
	if (value.status !== "active" && value.status !== "completing" && value.status !== "inactive") {
		throw new Error("Incompatible Director run state: unsupported status")
	}
	requireString(value.runId, "runId")
	requireString(value.objective, "objective")
	if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
		throw new Error("Invalid Director run state: revision must be a non-negative integer")
	}
	requireString(value.updatedAt, "updatedAt")
	if (Number.isNaN(Date.parse(value.updatedAt as string)))
		throw new Error("Invalid Director run state: updatedAt must be a timestamp")
	assertValidDirectorPlan(value.plan)
}

export function renderDirectorStatus(state: DirectorRunState): string {
	const counts = new Map<DirectorTaskStatus, number>()
	for (const task of state.plan.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
	const summary =
		(["completed", "running", "pending", "blocked", "skipped"] as const)
			.filter((status) => (counts.get(status) ?? 0) > 0)
			.map((status) => `${counts.get(status)} ${status}`)
			.join(" · ") || "0 tasks"
	const workers = Object.values(state.plan.workers)
	const workerLines = workers.length
		? [
				...workers
					.slice(0, 12)
					.map((worker) => `- ${worker.id} ${worker.type} ${worker.status} (${worker.disposition})`),
				...(workers.length > 12 ? [`- … ${workers.length - 12} more`] : []),
			].join("\n")
		: "- none"
	return [
		`Director ${state.status}: ${state.objective}`,
		`Phase: ${state.plan.currentPhase} · revision ${state.revision}`,
		`Tasks: ${summary}`,
		`Workers:\n${workerLines}`,
	].join("\n")
}
