// ACP plan tracking: translates the ferment lifecycle into ACP `plan`
// sessionUpdates for clients that render structured plan progress (e.g. AO's
// chat UI).
//
// Signal path:
//   1. FERMENT_EVENTS.PHASE_STARTED (pi.events bus, same bus the todo-sync
//      bridge uses) → build the initial plan from the active ferment via
//      getActive(), every entry `pending`, and emit.
//   2. subscribeTodoStore() → on each ferment-scoped store change, translate
//      TodoItem[] back into PlanEntry[] and emit.
//
// The execute path (plan-approved-without-ferment) creates no ferment and
// emits no lifecycle events, so nothing is sent — the ticket's explicit
// choice: a plan whose statuses never update would be misleading.
//
// ACP v1 note: the wire format is a single unnamed plan
// (`sessionUpdate: "plan"` with `Plan = { entries }`). The tracker's
// activePlan still carries a `planId` (= ferment.id) so a future v2
// (`plan_update` / `PlanItems`) migration has the identifier ready.

import type { PlanEntry, PlanEntryStatus, SessionNotification } from "@agentclientprotocol/sdk"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import { FERMENT_EVENTS, type FermentPhaseStartedPayload } from "../../extensions/ferment/domain-events.js"
import { getActive } from "../../extensions/ferment/state.js"
import { getTodoScopeKey } from "../../extensions/todos/scope.js"
import { getTodoState, subscribeTodoStore } from "../../extensions/todos/store.js"
import type { TodoItem, TodoStatus, TodosSliceState } from "../../extensions/todos/types.js"
import type { Ferment } from "../../ferment/types.js"

export interface ActivePlan {
	/** V2-ready identifier. For ferments this is `ferment.id`. */
	planId: string
	entries: PlanEntry[]
}

export interface AcpPlanTrackerOptions {
	sessionId: string
	/** Bus carrying ferment domain events. May be undefined when the ferment
	 *  extension is disabled — the tracker then only follows todo store
	 *  changes (which likewise can only come from a running ferment). */
	events: EventBus | undefined
	send: (notification: SessionNotification) => void
	/** Injectable for tests. Defaults to the process-level ferment state. */
	getActiveFerment?: () => Ferment | undefined
	/** Mirror hook so the ACP server can keep the active plan on its
	 *  SessionRecord (v2-ready storage). */
	onActivePlanChanged?: (plan: ActivePlan | undefined) => void
}

/** ACP v1 has no "blocked" status. A blocked todo was started but cannot
 *  proceed, so it maps to "in_progress" (revisit for v2, which adds
 *  "cancelled"). */
export function todoStatusToPlanEntryStatus(status: TodoStatus): PlanEntryStatus {
	if (status === "blocked") return "in_progress"
	return status
}

function todoToPlanEntry(todo: TodoItem): PlanEntry {
	return { content: todo.content, priority: "medium", status: todoStatusToPlanEntryStatus(todo.status) }
}

/** Initial plan for a ferment: one entry per phase (header) plus one per
 *  step, all pending. Content matches the todo-sync bridge's format
 *  (`[Phase N] name`, `↳ description`) so the first store-driven rebuild
 *  carries identical content strings. */
export function createInitialPlanEntries(ferment: Ferment): PlanEntry[] {
	const entries: PlanEntry[] = []
	for (const phase of ferment.phases) {
		entries.push({ content: `[Phase ${phase.index}] ${phase.name}`, priority: "medium", status: "pending" })
		for (const step of phase.steps) {
			entries.push({ content: `↳ ${step.description}`, priority: "medium", status: "pending" })
		}
	}
	return entries
}

/** Flatten ferment-scoped todos into plan entries, ordered by phase then
 *  step following the ferment's own ordering. Global-scope todos belong to
 *  the user, not the ferment, and are excluded — as are scopes of any other
 *  ferment. */
export function todoStoreToPlanEntries(state: TodosSliceState, ferment: Ferment): PlanEntry[] {
	const entries: PlanEntry[] = []
	for (const phase of ferment.phases) {
		const phaseKey = getTodoScopeKey({ kind: "ferment", phaseId: phase.id })
		for (const todo of state.byScope[phaseKey]?.todos ?? []) {
			entries.push(todoToPlanEntry(todo))
		}
		for (const step of phase.steps) {
			const stepKey = getTodoScopeKey({ kind: "ferment-step", phaseId: phase.id, stepId: step.id })
			for (const todo of state.byScope[stepKey]?.todos ?? []) {
				entries.push(todoToPlanEntry(todo))
			}
		}
	}
	return entries
}

/**
 * Owns the active ACP plan for one session and emits `plan` sessionUpdates
 * as the ferment lifecycle and todo store change. Start it after the
 * session's extensions are bound (so the ferment extension has already
 * wired the events bus) and stop it when the session is disposed.
 */
export class AcpPlanTracker {
	private activePlan: ActivePlan | undefined
	private unsubscribeEvents: (() => void) | undefined
	private unsubscribeTodos: (() => void) | undefined
	private lastEmittedKey = ""
	private readonly getActiveFerment: () => Ferment | undefined

	constructor(private readonly options: AcpPlanTrackerOptions) {
		this.getActiveFerment = options.getActiveFerment ?? getActive
	}

	start(): void {
		// The todo-sync bridge subscribes to the bus at session_start (inside
		// bindExtensions), so by the time the server starts the tracker its
		// PHASE_STARTED handler runs *before* this one for the same event —
		// the bridge's phase-scope write is already in the store and fires no
		// rebuild from us (activePlan is still undefined), leaving our initial
		// all-pending emission as the first plan the client sees.
		if (this.options.events) {
			this.unsubscribeEvents = this.options.events.on(FERMENT_EVENTS.PHASE_STARTED, (raw) => this.onPhaseStarted(raw))
		}
		this.unsubscribeTodos = subscribeTodoStore((_details, emitterSessionId) =>
			this.onTodoStoreChanged(emitterSessionId),
		)
	}

	stop(): void {
		this.unsubscribeEvents?.()
		this.unsubscribeEvents = undefined
		this.unsubscribeTodos?.()
		this.unsubscribeTodos = undefined
		this.setActivePlan(undefined)
	}

	private setActivePlan(plan: ActivePlan | undefined): void {
		this.activePlan = plan
		this.options.onActivePlanChanged?.(plan)
	}

	private onPhaseStarted(raw: unknown): void {
		const payload = raw as FermentPhaseStartedPayload
		const ferment = this.getActiveFerment()
		// Guard mirrors the todo-sync bridge: ignore events for a ferment that
		// isn't the currently active one.
		if (!ferment || ferment.id !== payload.fermentId) return
		const plan: ActivePlan = { planId: ferment.id, entries: createInitialPlanEntries(ferment) }
		this.setActivePlan(plan)
		this.emit(plan.entries)
	}

	private onTodoStoreChanged(emitterSessionId: string): void {
		if (!this.activePlan) return
		if (emitterSessionId !== this.options.sessionId) return
		const ferment = this.getActiveFerment()
		if (!ferment || ferment.id !== this.activePlan.planId) return
		const plan: ActivePlan = {
			planId: ferment.id,
			entries: todoStoreToPlanEntries(getTodoState(this.options.sessionId), ferment),
		}
		this.setActivePlan(plan)
		this.emit(plan.entries)
	}

	private emit(entries: PlanEntry[]): void {
		// The todo-sync bridge performs several writes per lifecycle event
		// (sweep + rebuild), so dedupe consecutive identical plans instead of
		// flooding the client with no-op updates.
		const key = JSON.stringify(entries)
		if (key === this.lastEmittedKey) return
		this.lastEmittedKey = key
		this.send({
			sessionId: this.options.sessionId,
			update: { sessionUpdate: "plan", entries },
		})
	}

	private send(notification: SessionNotification): void {
		this.options.send(notification)
	}
}
