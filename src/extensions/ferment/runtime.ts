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
import type { PersistedPhaseRefusal } from "./runtime-state-store.js"
import type { AttachPendingProposalPartial, PendingScope } from "./scoping.js"
import {
	attachPendingProposal,
	clearAllPendingScopes,
	clearPendingScope,
	getPendingScope,
	setPendingScope,
} from "./scoping.js"
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
	clearLastMidTurnFireTokens,
	clearLifecycleGuardRetryState,
	clearMidTurnCompactionTracking,
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
	getLastMidTurnFireTokens,
	getLastPhaseRefusal,
	getPendingCompaction,
	getPhaseStartRef,
	getStepStartRef,
	getStorage,
	hasMidTurnOneshotWarning,
	isAutomatedContinuationEnabled,
	isCompactionInFlight,
	isMidTurnInlineSuppressed,
	isScopingConfirmed,
	isScopingInteractive,
	markCompactionInFlight,
	markHumanInput,
	markMidTurnInlineSuppressed,
	markMidTurnOneshotWarning,
	markScopingConfirmed,
	markScopingInteractive,
	recordBlockHashAndCheckRepeat,
	setActive,
	setAutomatedContinuationEnabled,
	setContinuationPolicy,
	setLastMidTurnFireTokens,
	setLastPhaseRefusal,
	setPendingCompaction,
	setPhaseStartRef,
	setStepStartRef,
} from "./state.js"

export interface FermentRuntime {
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
	captureJudgeContext(model?: Model<Api>, registry?: ModelRegistry, multiModelEnabled?: boolean): void
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
	/** Delta-grading memory: the latest LLM-grader refusal of this phase. */
	setLastPhaseRefusal(fermentId: string, phaseId: string, refusal: PersistedPhaseRefusal): void
	getLastPhaseRefusal(fermentId: string, phaseId: string): PersistedPhaseRefusal | undefined
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
	/** Record totalTokens at the last mid-turn inline-compaction fire. */
	setLastMidTurnFireTokens(fermentId: string, tokens: number): void
	getLastMidTurnFireTokens(fermentId: string): number | undefined
	clearLastMidTurnFireTokens(fermentId: string): void
	/** Proven no-op inline path — use the aborting fallback from now on. */
	markMidTurnInlineSuppressed(fermentId: string): void
	isMidTurnInlineSuppressed(fermentId: string): boolean
	clearMidTurnCompactionTracking(): void
}

function getCurrentPendingPlanReview(): PendingPlanReview | undefined {
	const activeId = getActiveId()
	return activeId ? getPendingPlanReview(activeId) : undefined
}

function clearFermentState(fermentId: string): void {
	clearStateForFerment(fermentId)
	clearPendingScope(fermentId)
	clearPendingPlanReview(fermentId)
}

export function createDefaultFermentRuntime(): FermentRuntime {
	const runtime: FermentRuntime = {
		events: undefined,
		getStorage,
		getActive,
		getActiveId,
		setActive,
		getContinuationPolicy,
		setContinuationPolicy,
		isAutomatedContinuationEnabled,
		setAutomatedContinuationEnabled,
		onLifecycleTransitionApplied: clearLifecycleGuardRetryState,
		now: () => new Date(),
		nowIso: () => new Date().toISOString(),
		markHumanInput: () => {
			markHumanInput()
			const active = getActive()
			if (active && runtime.events) {
				runtime.events.emit(FERMENT_EVENTS.STEERING, { fermentId: active.id })
			}
		},
		getLastHumanInputAt,
		captureJudgeContext,
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
		getCurrentPendingPlanReview,
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
		setLastPhaseRefusal,
		getLastPhaseRefusal,
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
		setLastMidTurnFireTokens,
		getLastMidTurnFireTokens,
		clearLastMidTurnFireTokens,
		markMidTurnInlineSuppressed,
		isMidTurnInlineSuppressed,
		clearMidTurnCompactionTracking,
	}
	return runtime
}

export const defaultFermentRuntime = createDefaultFermentRuntime()
