// ACP plan tracking: translates the ferment lifecycle and todo store into
// ACP `plan` sessionUpdates for clients that render structured plan progress
// (e.g. Zed's agent panel, AO's chat UI).
//
// Two emission paths:
//
//   1. Ferment path (structured): FERMENT_EVENTS.PHASE_STARTED → build the
//      initial plan from the active ferment via getActive(), every entry
//      `pending`. Subsequent todo store changes translate ferment-scoped
//      TodoItem[] → PlanEntry[] (phases + steps, ordered).
//
//   2. Plan-mode path (flat): after the user approves a plan-mode plan
//      (PERMISSION_EVENTS.PLAN_APPROVED), emit from the session's
//      global-scope todos. Pre-approval todos are the agent's planning
//      scratchpad, and ad-hoc todos from unrelated work are noise — both
//      stay out of the client's plan panel.
//
// When a ferment starts, the ferment path takes over and the global-scope
// todos are excluded. When the ferment completes, the tracker clears the
// plan (empty entries array).
//
// ACP v1 note: the wire format is a single unnamed plan
// (`sessionUpdate: "plan"` with `Plan = { entries }`). The tracker's
// activePlan carries a `planId` (= ferment.id for ferments, `"main"` for
// plan-mode) so a future v2 (`plan_update` / `PlanItems`) migration has
// the identifier ready.

import type { PlanEntry, PlanEntryStatus, SessionNotification } from "@agentclientprotocol/sdk"
import type { EventBus, SessionEntry } from "@earendil-works/pi-coding-agent"
import { FERMENT_EVENTS, type FermentPhaseStartedPayload } from "../../extensions/ferment/domain-events.js"
import { getPendingScope, type PendingScope } from "../../extensions/ferment/scoping.js"
import { getActive } from "../../extensions/ferment/state.js"
import { getTodoScopeKey } from "../../extensions/todos/scope.js"
import { getWriteTodosDetails } from "../../extensions/todos/session.js"
import { GLOBAL_TODO_SCOPE, getTodoState, getTodosForScope, subscribeTodoStore } from "../../extensions/todos/store.js"
import type { TodoItem, TodoStatus, TodosSliceState } from "../../extensions/todos/types.js"
import type { Ferment } from "../../ferment/types.js"
import { parseSharedPlan } from "../../shared/planning/plan-decomposition.js"
import { derivePlanTitle } from "../../shared/planning/plan-markdown.js"
import {
	PLAN_REVIEW_REQUEST_CHANNEL,
	PLAN_REVIEW_RESOLVED_CHANNEL,
	PLAN_REVIEW_RESOLVED_CUSTOM_TYPE,
	type PlanReviewRequestPayload,
	type PlanReviewResolvedPayload,
} from "../../shared/planning/plan-review-bus.js"

/** planId for non-ferment plans. Matches the ACP v2 migration recommendation
 *  for adapting v1 single-plan updates to v2 (`id: "main"`). */
const PLAN_MODE_PLAN_ID = "main"
const PENDING_REVIEW_PLAN_ID = "pending-review"

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
	/** Current permission mode for this session. Defaults to direct/global todos. */
	getPermissionMode?: () => string | undefined
	/** Session branch provider used for restore ordering. */
	getSessionEntries?: () => readonly SessionEntry[]
	/** Injectable for tests. Defaults to Ferment's pending scope buffer. */
	getPendingFermentScope?: (fermentId: string) => PendingScope | undefined
	/** Mirror hook so the ACP server can keep the active plan on its
	 *  SessionRecord (v2-ready storage). */
	onActivePlanChanged?: (plan: ActivePlan | undefined) => void
}

/** ACP v1 has no "blocked" status. Rather than silently showing a blocked
 *  item as in-progress (misleading — the user can't tell why it stalled),
 *  blocked items map to "pending" with a `[blocked]` content marker; the todo
 *  note (typically the blocker reason) is appended when present. Revisit
 *  for v2, which adds "cancelled". */
export function todoStatusToPlanEntryStatus(status: TodoStatus): PlanEntryStatus {
	if (status === "blocked") return "pending"
	return status
}

function todoToPlanEntry(todo: TodoItem): PlanEntry {
	if (todo.status === "blocked") {
		const note = todo.note ? ` — ${todo.note}` : ""
		return { content: `[blocked] ${todo.content}${note}`, priority: "medium", status: "pending" }
	}
	// In-progress entries prefer the present-continuous activeForm
	// ("writing tests") over the static content ("write tests").
	const content = todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content
	return { content, priority: "medium", status: todoStatusToPlanEntryStatus(todo.status) }
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

/** Flatten global-scope todos into plan entries for non-ferment sessions.
 *  Used when no ferment is active — covers regular plan mode and ad-hoc
 *  todo usage. */
export function globalTodosToPlanEntries(state: TodosSliceState): PlanEntry[] {
	const globalKey = getTodoScopeKey(GLOBAL_TODO_SCOPE)
	return (state.byScope[globalKey]?.todos ?? []).map(todoToPlanEntry)
}

function pendingEntry(content: string): PlanEntry {
	return { content, priority: "medium", status: "pending" }
}

function fallbackPlanTitle(markdown: string): string {
	return (
		derivePlanTitle(markdown) ||
		markdown
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ||
		"untitled-plan"
	)
}

export function proposalRequestToPlanEntries(
	payload: PlanReviewRequestPayload,
	getPendingFermentScope: (fermentId: string) => PendingScope | undefined = getPendingScope,
): PlanEntry[] {
	if (payload.source === "ferment" && payload.fermentId) {
		const pending = getPendingFermentScope(payload.fermentId)
		if (pending?.phases?.length) {
			const entries: PlanEntry[] = []
			pending.phases.forEach((phase, index) => {
				entries.push(pendingEntry(`[Phase ${index + 1}] ${phase.name}`))
				for (const step of phase.steps ?? []) {
					entries.push(pendingEntry(`↳ ${step.description}`))
				}
			})
			return entries
		}
	}

	const parsed = parseSharedPlan(payload.planContent)
	if (parsed.chunks.length > 0) {
		return parsed.chunks.map((chunk) => pendingEntry(chunk.title))
	}
	return [pendingEntry(fallbackPlanTitle(payload.planContent))]
}

function isResolvedEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === PLAN_REVIEW_RESOLVED_CUSTOM_TYPE
}

function isGlobalTodoEntry(entry: SessionEntry): boolean {
	const details = getWriteTodosDetails(entry)
	return details?.scope.kind === GLOBAL_TODO_SCOPE.kind
}

function hasGlobalTodoAfterLatestReviewResolution(entries: readonly SessionEntry[]): boolean {
	let latestResolvedIndex = -1
	let latestGlobalTodoIndex = -1
	entries.forEach((entry, index) => {
		if (isResolvedEntry(entry)) latestResolvedIndex = index
		if (isGlobalTodoEntry(entry)) latestGlobalTodoIndex = index
	})
	return latestResolvedIndex < 0 || latestGlobalTodoIndex > latestResolvedIndex
}

/** Flatten ferment-scoped todos into plan entries, ordered by phase then
 *  step following the ferment's own ordering. Global-scope todos belong to
 *  the user, not the ferment, and are excluded — as are scopes of any other
 *  ferment.
 *
 *  Phases whose scopes currently have no todos drop out of the flattened
 *  plan: not-yet-started phases never populated their scope, and completed
 *  phases get cleared by the bridge. The next PHASE_STARTED re-emits an
 *  initial all-pending plan built from the ferment, so pending entries for
 *  later phases reappear when their phase becomes current. Deferred product
 *  decision (PR #1034 review, finding 2): merging placeholders for future
 *  phases from the previously emitted plan is possible if clients want
 *  forward-looking visibility. */
/** Reserved `_syncKey` the todo-sync bridge stamps on the step anchor it
 *  seeds at STEP_STARTED (see handleStepStarted). */
const STEP_ANCHOR_SYNC_KEY = "anchor"

/** Mirror of the todos reducer's text normalization so seeded content can be
 *  compared against its stored form: the store trims and collapses
 *  whitespace, while the bridge's seeded strings can contain newlines or
 *  runs of spaces (real step descriptions are multi-line, with newline-
 *  delimited "Scope:", "Files Changed:" sections). Exact string equality
 *  misses them; naive matching was the bug observed as duplicate Chunk
 *  rows in the zed plan panel. */
function normalizeTodoText(text: string): string {
	return text.trim().replace(/\s+/g, " ")
}

/** True for the bridge-seeded step anchor: the exact `[Step M] description`
 *  todo the todo-sync bridge writes into the step scope at STEP_STARTED.
 *  Matched by the reserved `_syncKey` first (robust against the store's
 *  whitespace normalization), with a normalized-content fallback for
 *  anchors persisted before the key existed. */
function isSeededStepAnchor(todo: TodoItem, step: { index: number; description: string }): boolean {
	if (todo._syncKey === STEP_ANCHOR_SYNC_KEY) return true
	return todo.content === normalizeTodoText(`[Step ${step.index}] ${step.description}`)
}

/** The todo-sync bridge seeds each phase scope with a `↳ <step>` summary row
 *  AND, when the step starts, a separate `[Step M]` anchor in the step scope.
 *  Emitted verbatim, the step shows up twice in the plan: the phase row lags
 *  at its seeded status (the bridge only flips it at STEP_COMPLETED) while
 *  the live anchor displays via activeForm — observed as a duplicated
 *  "Chunk 1" row pair in the zed plan panel.
 *
 *  Merge instead: the anchor's live in_progress status propagates onto the
 *  phase summary row and the anchor entry itself is suppressed. Model-written
 *  sub-tasks in the step scope still emit; only the seeded anchor is dropped. */
function mergeStepAnchorIntoSummary(
	summary: TodoItem,
	steps: { id: string; index: number; description: string }[],
	anchorByStepId: ReadonlyMap<string, TodoItem>,
): TodoItem {
	// Correlate the summary row to its step: `_syncKey` when bridge-seeded,
	// falling back to normalized `↳ description` content for model-written
	// lists that dropped the key.
	const step =
		steps.find((s) => summary._syncKey === s.id) ??
		steps.find((s) => summary.content === normalizeTodoText(`↳ ${s.description}`))
	if (!step) return summary
	const anchor = anchorByStepId.get(step.id)
	if (!anchor) return summary
	// Upgrade only: pending → in_progress. Other states reconcile through the
	// bridge's own lifecycle writes (STEP_COMPLETED sets the summary row), so
	// racing them here would fight the bridge.
	if (summary.status === "pending" && anchor.status === "in_progress") {
		return { ...summary, status: "in_progress" }
	}
	return summary
}

export function todoStoreToPlanEntries(state: TodosSliceState, ferment: Ferment): PlanEntry[] {
	const entries: PlanEntry[] = []
	for (const phase of ferment.phases) {
		const phaseKey = getTodoScopeKey({ kind: "ferment", phaseId: phase.id })
		const phaseTodos = state.byScope[phaseKey]?.todos ?? []

		// Locate the seeded anchor per step (reference identity so the suppress
		// pass below can match by object, surviving duplicate-content models).
		const anchorByStepId = new Map<string, TodoItem>()
		for (const step of phase.steps) {
			const stepKey = getTodoScopeKey({ kind: "ferment-step", phaseId: phase.id, stepId: step.id })
			const anchor = state.byScope[stepKey]?.todos.find((t) => isSeededStepAnchor(t, step))
			if (anchor) anchorByStepId.set(step.id, anchor)
		}

		for (const todo of phaseTodos) {
			entries.push(todoToPlanEntry(mergeStepAnchorIntoSummary(todo, phase.steps, anchorByStepId)))
		}
		for (const step of phase.steps) {
			const stepKey = getTodoScopeKey({ kind: "ferment-step", phaseId: phase.id, stepId: step.id })
			for (const todo of state.byScope[stepKey]?.todos ?? []) {
				if (anchorByStepId.get(step.id) === todo) continue
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
	private unsubscribePlanReviewRequest: (() => void) | undefined
	private unsubscribePlanReviewResolved: (() => void) | undefined
	private lastEmittedKey = ""
	private started = false
	private pendingReview:
		| {
				fermentId?: string
				source: "adhoc" | "ferment"
		  }
		| undefined
	private readonly getActiveFerment: () => Ferment | undefined
	private readonly getPendingFermentScope: (fermentId: string) => PendingScope | undefined

	constructor(private readonly options: AcpPlanTrackerOptions) {
		this.getActiveFerment = options.getActiveFerment ?? getActive
		this.getPendingFermentScope = options.getPendingFermentScope ?? getPendingScope
	}

	start(): void {
		// Idempotent: a second start() would overwrite the unsubscribers
		// without calling the old ones, leaking subscriptions.
		if (this.started) return
		this.started = true
		// The todo-sync bridge subscribes to the bus at session_start (inside
		// bindExtensions), so by the time the server starts the tracker its
		// PHASE_STARTED handler runs *before* this one for the same event —
		// the bridge's phase-scope write is already in the store and fires no
		// rebuild from us (activePlan is still undefined), leaving our initial
		// all-pending emission as the first plan the client sees.
		if (this.options.events) {
			this.unsubscribeEvents = this.options.events.on(FERMENT_EVENTS.PHASE_STARTED, (raw) => this.onPhaseStarted(raw))
			this.unsubscribePlanReviewRequest = this.options.events.on(PLAN_REVIEW_REQUEST_CHANNEL, (raw) =>
				this.onPlanReviewRequest(raw),
			)
			this.unsubscribePlanReviewResolved = this.options.events.on(PLAN_REVIEW_RESOLVED_CHANNEL, (raw) =>
				this.onPlanReviewResolved(raw),
			)
		}
		this.unsubscribeTodos = subscribeTodoStore((_details, emitterSessionId) =>
			this.onTodoStoreChanged(emitterSessionId),
		)
	}

	stop(): void {
		if (!this.started) return
		this.started = false
		this.unsubscribeEvents?.()
		this.unsubscribeEvents = undefined
		this.unsubscribePlanReviewRequest?.()
		this.unsubscribePlanReviewRequest = undefined
		this.unsubscribePlanReviewResolved?.()
		this.unsubscribePlanReviewResolved = undefined
		this.unsubscribeTodos?.()
		this.unsubscribeTodos = undefined
		// Reset the dedupe cache so a tracker accidentally restarted emits the
		// current state instead of being suppressed by the stale key.
		this.lastEmittedKey = ""
		this.pendingReview = undefined
		this.setActivePlan(undefined)
	}

	private setActivePlan(plan: ActivePlan | undefined): void {
		this.activePlan = plan
		// The mirror callback mutates server-owned state; a failure here must
		// not escape into the EventBus/todo-store notify loops and break the
		// subscribers that run after us.
		try {
			this.options.onActivePlanChanged?.(plan)
		} catch (err) {
			console.error("[acp-plan] onActivePlanChanged callback failed:", err)
		}
	}

	/**
	 * Emit one plan snapshot from restored todos. Called after a session
	 * resume (ACP `loadSession`): the todo store has been restored from the
	 * persisted session branch, but no PHASE_STARTED will fire again for the
	 * already-active phase, so without this the client sees no plan until
	 * the next todo store change.
	 *
	 * If a ferment is active, the snapshot comes from ferment-scoped todos.
	 * Otherwise, falls back to global-scope todos (plan-mode resume).
	 */
	emitRestoredSnapshot(): void {
		const ferment = this.getActiveFerment()
		if (ferment) {
			const entries = todoStoreToPlanEntries(getTodoState(this.options.sessionId), ferment)
			if (entries.length > 0) {
				const plan: ActivePlan = { planId: ferment.id, entries }
				this.setActivePlan(plan)
				this.emit(plan.entries)
				return
			}
		}
		// No ferment — resume from global-scope todos only when they are visible
		// for this permission mode and are newer than any review-resolution marker.
		if (!this.shouldShowGlobalTodos()) return
		if (!this.hasRestorableGlobalTodos()) return
		const entries = globalTodosToPlanEntries(getTodoState(this.options.sessionId))
		if (entries.length === 0) return
		const plan: ActivePlan = { planId: PLAN_MODE_PLAN_ID, entries }
		this.setActivePlan(plan)
		this.emit(plan.entries)
	}

	private shouldShowGlobalTodos(): boolean {
		return this.options.getPermissionMode?.() !== "plan"
	}

	private hasRestorableGlobalTodos(): boolean {
		const entries = this.options.getSessionEntries?.()
		return entries ? hasGlobalTodoAfterLatestReviewResolution(entries) : true
	}

	private onPlanReviewRequest(raw: unknown): void {
		const payload = raw as PlanReviewRequestPayload
		if (payload.sessionId !== this.options.sessionId) return
		const entries = proposalRequestToPlanEntries(payload, this.getPendingFermentScope)
		this.pendingReview = { source: payload.source, fermentId: payload.fermentId }
		const plan: ActivePlan = { planId: PENDING_REVIEW_PLAN_ID, entries }
		this.setActivePlan(plan)
		this.emit(plan.entries)
	}

	private onPlanReviewResolved(raw: unknown): void {
		const payload = raw as PlanReviewResolvedPayload
		if (payload.sessionId !== this.options.sessionId) return
		this.pendingReview = undefined
		if (
			payload.outcome === "replaced_by_ferment" &&
			payload.fermentId &&
			this.activePlan?.planId === payload.fermentId
		) {
			return
		}
		this.setActivePlan(undefined)
		this.emit([])
	}

	private onPhaseStarted(raw: unknown): void {
		const payload = raw as FermentPhaseStartedPayload
		const ferment = this.getActiveFerment()
		// Guard mirrors the todo-sync bridge: ignore events for a ferment that
		// isn't the currently active one.
		if (!ferment || ferment.id !== payload.fermentId) return
		// Session correlation: the ferment is process-global (getActive) and the
		// events bus can be shared across ACP sessions bound later in the same
		// process, so ferment identity alone does not prove ownership. The
		// todo-sync bridge, however, writes the phase's scope todos into the
		// OWNING session's bucket — and it subscribes at session_start, before
		// this tracker starts, so for the owning session those todos are already
		// in the store when this handler runs. If this session's bucket has no
		// todos for the started phase, the ferment belongs to another session:
		// don't advertise its plan here.
		if (getTodosForScope({ kind: "ferment", phaseId: payload.phaseId }, this.options.sessionId).length === 0) {
			return
		}
		const plan: ActivePlan = { planId: ferment.id, entries: createInitialPlanEntries(ferment) }
		this.pendingReview = undefined
		this.setActivePlan(plan)
		this.emit(plan.entries)
	}

	private onTodoStoreChanged(emitterSessionId: string): void {
		if (emitterSessionId !== this.options.sessionId) return
		if (this.pendingReview) return
		const ferment = this.getActiveFerment()

		// Ferment path: if a ferment is active and we already have a ferment
		// plan, update it from ferment-scoped todos.
		if (ferment && this.activePlan && ferment.id === this.activePlan.planId) {
			const plan: ActivePlan = {
				planId: ferment.id,
				entries: todoStoreToPlanEntries(getTodoState(this.options.sessionId), ferment),
			}
			this.setActivePlan(plan)
			this.emit(plan.entries)
			return
		}

		// Global todo path: visible outside plan/review mode. A process-global
		// ferment owned by another session must not suppress this session's direct
		// todos; only an owned ferment plan does that.
		if (this.shouldShowGlobalTodos()) {
			const entries = globalTodosToPlanEntries(getTodoState(this.options.sessionId))
			// Only emit when we have global todos OR when clearing a previously
			// active plan-mode plan (entries went from non-empty to empty).
			if (entries.length === 0 && this.activePlan?.planId !== PLAN_MODE_PLAN_ID) return
			const plan: ActivePlan = { planId: PLAN_MODE_PLAN_ID, entries }
			this.setActivePlan(plan)
			this.emit(plan.entries)
		}
	}

	private emit(entries: PlanEntry[]): void {
		// The todo-sync bridge performs several writes per lifecycle event
		// (sweep + rebuild), so dedupe consecutive identical plans instead of
		// flooding the client with no-op updates.
		const key = JSON.stringify(entries)
		if (key === this.lastEmittedKey) return
		// Set the dedupe key only after a successful send: if send throws, the
		// client never saw this plan and the next (possibly identical) update
		// must not be swallowed by the stale key.
		try {
			this.send({
				sessionId: this.options.sessionId,
				update: { sessionUpdate: "plan", entries },
			})
		} catch (err) {
			console.error("[acp-plan] plan sessionUpdate send failed:", err)
			return
		}
		this.lastEmittedKey = key
	}

	private send(notification: SessionNotification): void {
		this.options.send(notification)
	}
}
