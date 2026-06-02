import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { parseTodoScopeKey, todoScopeFromFermentScope } from "./scope.js"
import { getTodoCountsForScope, getTodoState } from "./store.js"
import type { FermentTodoCounts, FermentTodoScope, TodoItem, TodoScopeLevel } from "./types.js"

export const EMPTY_TODO_COUNTS: FermentTodoCounts = {
	total: 0,
	completed: 0,
	pending: 0,
	blocked: 0,
	inProgress: 0,
}

function makeScope(fermentId: string, level: TodoScopeLevel, phaseId?: string, stepId?: string): FermentTodoScope {
	return { level, fermentId, phaseId, stepId }
}

export function getActiveFermentStepScope(ferment: Ferment): FermentTodoScope | undefined {
	const activePhase =
		ferment.phases.find((phase) => phase.id === ferment.activePhaseId) ??
		ferment.phases.find((phase) => phase.status === "active") ??
		ferment.phases.find((phase) => phase.status === "planned") ??
		ferment.phases[0]
	if (!activePhase) return makeScope(ferment.id, "ferment")

	const activeStep =
		activePhase.steps.find((step) => step.status === "running" || step.status === "pending") ?? activePhase.steps[0]
	if (activeStep) {
		return makeScope(ferment.id, "step", activePhase.id, activeStep.id)
	}

	return makeScope(ferment.id, "phase", activePhase.id)
}

export function makePhaseTodoScope(fermentId: string, phase: Phase): FermentTodoScope {
	return makeScope(fermentId, "phase", phase.id)
}

export function makeStepTodoScope(fermentId: string, phase: Phase, step: Step): FermentTodoScope {
	return makeScope(fermentId, "step", phase.id, step.id)
}

function countTodos(todos: readonly TodoItem[]): FermentTodoCounts {
	return {
		total: todos.length,
		completed: todos.filter((todo) => todo.status === "completed").length,
		pending: todos.filter((todo) => todo.status === "pending").length,
		blocked: todos.filter((todo) => todo.status === "blocked").length,
		inProgress: todos.filter((todo) => todo.status === "in_progress").length,
	}
}

function addCounts(target: FermentTodoCounts, source: FermentTodoCounts): void {
	target.total += source.total
	target.completed += source.completed
	target.pending += source.pending
	target.blocked += source.blocked
	target.inProgress += source.inProgress
}

function getPhaseTodoProgress(scope: FermentTodoScope): FermentTodoCounts {
	if (!scope.phaseId) return EMPTY_TODO_COUNTS
	const total = { ...EMPTY_TODO_COUNTS }
	for (const [key, value] of Object.entries(getTodoState().byScope)) {
		const parsed = parseTodoScopeKey(key)
		if (
			(parsed.kind === "ferment_phase" || parsed.kind === "ferment_step") &&
			parsed.fermentId === scope.fermentId &&
			parsed.phaseId === scope.phaseId
		) {
			addCounts(total, countTodos(value.todos))
		}
	}
	return total
}

export function getTodoProgressForScope(_scope?: FermentTodoScope): FermentTodoCounts {
	if (_scope?.level === "phase") return getPhaseTodoProgress(_scope)
	const scope = _scope ? todoScopeFromFermentScope(_scope) : undefined
	if (!scope) return EMPTY_TODO_COUNTS
	return getTodoCountsForScope(scope)
}

export function formatTodoCounts(counts: FermentTodoCounts): string {
	if (counts.total === 0) return ""
	const inProgress = counts.inProgress ?? 0
	const blockedCount = counts.blocked ?? 0
	const pending = counts.pending ?? Math.max(0, counts.total - counts.completed - inProgress - blockedCount)
	const blocked = blockedCount > 0 ? `, ${blockedCount} blocked` : ""
	return `todo ${counts.completed}/${counts.total} (${pending} pending${blocked})`
}
