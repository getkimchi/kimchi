import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	type PendingPlanReview,
	clearAllPendingPlanReviews,
	clearPendingPlanReview,
	getPendingPlanReview,
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
	bumpBlockRetry,
	bumpStepCompleteAttempt,
	bumpStepStart,
	captureJudgeContext,
	clearAllScopingGates,
	clearAllStepStarts,
	clearBlockRetry,
	clearFermentState as clearStateForFerment,
	clearStepCompleteAttempt,
	clearStepStart,
	consumeScopingGate,
	getActive,
	getActiveId,
	getBlockRetry,
	getContinuationPolicy,
	getLastHumanInputAt,
	getPhaseStartRef,
	getStepStartRef,
	getStorage,
	isAutomatedContinuationEnabled,
	isScopingConfirmed,
	isScopingInteractive,
	markHumanInput,
	markScopingConfirmed,
	markScopingInteractive,
	recordBlockHashAndCheckRepeat,
	setActive,
	setAutomatedContinuationEnabled,
	setContinuationPolicy,
	setPhaseStartRef,
	setStepStartRef,
} from "./state.js"
import type { ContinuationPolicy } from "./state.js"

export interface FermentRuntime {
	getStorage(): FermentEventStore
	getActive(): Ferment | undefined
	getActiveId(): string | undefined
	setActive(ferment: Ferment | undefined): void
	getContinuationPolicy(): ContinuationPolicy
	setContinuationPolicy(policy: ContinuationPolicy): void
	isAutomatedContinuationEnabled(): boolean
	setAutomatedContinuationEnabled(enabled: boolean): void
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
	return {
		getStorage,
		getActive,
		getActiveId,
		setActive,
		getContinuationPolicy,
		setContinuationPolicy,
		isAutomatedContinuationEnabled,
		setAutomatedContinuationEnabled,
		now: () => new Date(),
		nowIso: () => new Date().toISOString(),
		markHumanInput,
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
		bumpStepCompleteAttempt,
		clearStepCompleteAttempt,
		clearFermentState,
	}
}

export const defaultFermentRuntime = createDefaultFermentRuntime()
