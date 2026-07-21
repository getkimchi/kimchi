import type { Api, Model } from "@earendil-works/pi-ai"
import type { EventBus, ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import {
	clearAllPendingPlanReviews,
	clearPendingPlanReview,
	getPendingPlanReview,
	type PendingPlanReview,
	setPendingPlanReview,
} from "./plan-review.js"
import type { AttachPendingProposalPartial, PendingScope } from "./scoping.js"
import {
	attachPendingProposal,
	clearAllPendingScopes,
	clearPendingScope,
	getPendingScope,
	setPendingScope,
} from "./scoping.js"
import {
	createFermentSessionState,
	defaultFermentSessionState,
	type FermentSessionState,
} from "./session-state.js"
import type { ContinuationPolicy, PendingCompaction } from "./state.js"
import {
	bumpBlockRetry,
	bumpStepCompleteAttempt,
	bumpStepStart,
	captureJudgeContext,
	clearAllPendingCompactions,
	clearAllScopingGates,
	clearAllStepStarts,
	clearBlockRetry,
	clearCompactionInFlight,
	clearLifecycleGuardRetryState,
	clearMidTurnOneshotWarnings,
	clearPendingCompaction,
	clearFermentState as clearStateForFerment,
	clearStepCompleteAttempt,
	clearStepStart,
	consumeScopingGate,
	drainPendingCompactions,
	getActive,
	getActiveId,
	getBlockRetry,
	getContinuationPolicy,
	getLastHumanInputAt,
	getPendingCompaction,
	getPhaseStartRef,
	getStepStartRef,
	getStorage,
	hasMidTurnOneshotWarning,
	isAutomatedContinuationEnabled,
	isCompactionInFlight,
	isScopingConfirmed,
	isScopingInteractive,
	markCompactionInFlight,
	markHumanInput,
	markMidTurnOneshotWarning,
	markScopingConfirmed,
	markScopingInteractive,
	recordBlockHashAndCheckRepeat,
	setActive,
	setAutomatedContinuationEnabled,
	setContinuationPolicy,
	setPendingCompaction,
	setPhaseStartRef,
	setStepStartRef,
} from "./state.js"

export interface FermentRuntime {
	/** Per-session ferment state backing this runtime. Exposed so the extension
	 *  factory can register the state in the cross-session lookup registry. */
	sessionState: FermentSessionState
	/** pi.events bus — set by the ferment extension factory so all mutations
	 *  can emit domain events for subscribers (e.g. telemetry). Undefined in
	 *  tests and non-UI code paths that don't have access to pi. */
	events: EventBus | undefined
	getStorage(): FermentEventStore
	getActive(): Ferment | undefined
	getActiveId(): string | undefined
	setActive(ferment: Ferment | undefined): void
	getContinuationPolicy(): ContinuationPolicy
	setContinuationPolicy(policy: ContinuationPolicy): void
	isAutomatedContinuationEnabled(): boolean
	setAutomatedContinuationEnabled(enabled: boolean): void
	/** Coordinate session-local recovery state after a state-machine command
	 *  has been successfully persisted. */
	onLifecycleTransitionApplied(fermentId: string): void
	now(): Date
	nowIso(): string
	markHumanInput(): void
	getLastHumanInputAt(): Date | undefined
	captureJudgeContext(model?: Model<Api>, registry?: ModelRegistry): void
	bumpStepStart(fermentId: string, phaseId: string, stepId: string): number
	clearStepStart(fermentId: string, phaseId: string, stepId: string): void
	clearAllStepStarts(): void
	markScopingInteractive(fermentId: string): void
	markScopingConfirmed(fermentId: string): void
	isScopingInteractive(fermentId: string): boolean
	isScopingConfirmed(fermentId: string): boolean
	consumeScopingGate(fermentId: string): void
	clearAllScopingGates(): void
	getPendingScope(fermentId: string): PendingScope | undefined
	setPendingScope(fermentId: string, scope: PendingScope): void
	attachPendingProposal(fermentId: string, partial: AttachPendingProposalPartial): boolean
	clearPendingScope(fermentId: string): void
	clearAllPendingScopes(): void
	setPendingPlanReview(review: PendingPlanReview): void
	getPendingPlanReview(fermentId: string): PendingPlanReview | undefined
	getCurrentPendingPlanReview(): PendingPlanReview | undefined
	clearPendingPlanReview(fermentId: string): void
	clearAllPendingPlanReviews(): void
	setPhaseStartRef(fermentId: string, phaseId: string, ref: string): void
	getPhaseStartRef(fermentId: string, phaseId: string): string | undefined
	setStepStartRef(fermentId: string, phaseId: string, stepId: string, ref: string): void
	getStepStartRef(fermentId: string, phaseId: string, stepId: string): string | undefined
	bumpBlockRetry(fermentId: string, phaseId: string): number
	getBlockRetry(fermentId: string, phaseId: string): number
	clearBlockRetry(fermentId: string, phaseId: string): void
	recordBlockHashAndCheckRepeat(fermentId: string, phaseId: string, hash: string): boolean
	bumpStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): number
	clearStepCompleteAttempt(fermentId: string, phaseId: string, stepId: string): void
	clearFermentState(fermentId: string): void
	setPendingCompaction(fermentId: string, pending: PendingCompaction): void
	getPendingCompaction(fermentId: string): PendingCompaction | undefined
	clearPendingCompaction(fermentId: string): void
	/** Drain ready (non-in-flight) pending compactions, leaving in-flight ones for the next tick. */
	drainPendingCompactions(): PendingCompaction[]
	markCompactionInFlight(fermentId: string): void
	clearCompactionInFlight(fermentId: string): void
	isCompactionInFlight(fermentId: string): boolean
	clearAllPendingCompactions(): void
	markMidTurnOneshotWarning(fermentId: string): void
	hasMidTurnOneshotWarning(fermentId: string): boolean
	clearMidTurnOneshotWarnings(): void
}

function getCurrentPendingPlanReview(sessionState: FermentSessionState): PendingPlanReview | undefined {
	const activeId = getActiveId(sessionState)
	return activeId ? getPendingPlanReview(activeId) : undefined
}

function clearFermentState(fermentId: string): void {
	clearStateForFerment(fermentId)
	clearPendingScope(fermentId)
	clearPendingPlanReview(fermentId)
}

export function createFermentRuntime(sessionState: FermentSessionState = createFermentSessionState()): FermentRuntime {
	const runtime: FermentRuntime = {
		sessionState,
		events: undefined,
		getStorage,
		getActive: () => getActive(sessionState),
		getActiveId: () => getActiveId(sessionState),
		setActive: (f) => setActive(f, sessionState),
		getContinuationPolicy: () => getContinuationPolicy(sessionState),
		setContinuationPolicy: (policy) => setContinuationPolicy(policy, sessionState),
		isAutomatedContinuationEnabled: () => isAutomatedContinuationEnabled(sessionState),
		setAutomatedContinuationEnabled: (enabled) => setAutomatedContinuationEnabled(enabled, sessionState),
		onLifecycleTransitionApplied: clearLifecycleGuardRetryState,
		now: () => new Date(),
		nowIso: () => new Date().toISOString(),
		markHumanInput: () => {
			markHumanInput(sessionState)
			const active = getActive(sessionState)
			if (active && runtime.events) {
				runtime.events.emit(FERMENT_EVENTS.STEERING, { fermentId: active.id })
			}
		},
		getLastHumanInputAt: () => getLastHumanInputAt(sessionState),
		captureJudgeContext: (model, registry) => captureJudgeContext(model, registry, sessionState),
		bumpStepStart,
		clearStepStart,
		clearAllStepStarts,
		markScopingInteractive,
		markScopingConfirmed,
		isScopingInteractive,
		isScopingConfirmed,
		consumeScopingGate,
		clearAllScopingGates,
		getPendingScope,
		setPendingScope,
		attachPendingProposal,
		clearPendingScope,
		clearAllPendingScopes,
		setPendingPlanReview,
		getPendingPlanReview,
		getCurrentPendingPlanReview: () => getCurrentPendingPlanReview(sessionState),
		clearPendingPlanReview,
		clearAllPendingPlanReviews,
		setPhaseStartRef,
		getPhaseStartRef,
		setStepStartRef,
		getStepStartRef,
		bumpBlockRetry,
		getBlockRetry,
		clearBlockRetry,
		recordBlockHashAndCheckRepeat,
		bumpStepCompleteAttempt,
		clearStepCompleteAttempt,
		clearFermentState,
		getPendingCompaction,
		setPendingCompaction,
		clearPendingCompaction,
		drainPendingCompactions,
		markCompactionInFlight,
		clearCompactionInFlight,
		isCompactionInFlight,
		clearAllPendingCompactions,
		markMidTurnOneshotWarning,
		hasMidTurnOneshotWarning,
		clearMidTurnOneshotWarnings,
	}
	return runtime
}

/** Backward-compatible runtime factory for tests and single-session callers.
 *  Uses the default (singleton) session state so existing tests that mutate
 *  global state see the same runtime. */
export function createDefaultFermentRuntime(): FermentRuntime {
	return createFermentRuntime(defaultFermentSessionState)
}

/** Legacy singleton runtime for callers that do not yet receive a runtime
 *  instance. Uses the default session state. */
export const defaultFermentRuntime = createDefaultFermentRuntime()
