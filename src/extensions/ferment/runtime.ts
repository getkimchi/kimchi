import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { FermentEventStore } from "../../ferment/event-store.js"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import type { PendingScope } from "./scoping.js"
import {
	attachPendingPhases,
	clearAllPendingScopes,
	clearPendingScope,
	getPendingScope,
	setPendingScope,
} from "./scoping.js"
import {
	bumpStepStart,
	captureJudgeContext,
	clearAllScopingGates,
	clearAllStepStarts,
	clearFermentState,
	clearStepStart,
	consumeScopingGate,
	getActive,
	getActiveId,
	getCorrectiveStep,
	getLastHumanInputAt,
	getPhaseStartRef,
	getStepStartRef,
	getStorage,
	isAutoModeEnabled,
	isScopingConfirmed,
	isScopingInteractive,
	markHumanInput,
	markScopingConfirmed,
	markScopingInteractive,
	setActive,
	setAutoModeEnabled,
	setCorrectiveStep,
	setPhaseStartRef,
	setStepStartRef,
} from "./state.js"

export interface FermentRuntime {
	getStorage(): FermentEventStore
	getActive(): Ferment | undefined
	getActiveId(): string | undefined
	setActive(ferment: Ferment | undefined): void
	isAutoModeEnabled(): boolean
	setAutoModeEnabled(enabled: boolean): void
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
	setCorrectiveStep(fermentId: string, phaseId: string, step: string): void
	getCorrectiveStep(fermentId: string, phaseId: string): string | undefined
	getPendingScope(fermentId: string): PendingScope | undefined
	setPendingScope(fermentId: string, scope: PendingScope): void
	attachPendingPhases(fermentId: string, phases: ScopePhaseInput[]): boolean
	clearPendingScope(fermentId: string): void
	clearAllPendingScopes(): void
	setPhaseStartRef(fermentId: string, phaseId: string, ref: string): void
	getPhaseStartRef(fermentId: string, phaseId: string): string | undefined
	setStepStartRef(fermentId: string, phaseId: string, stepId: string, ref: string): void
	getStepStartRef(fermentId: string, phaseId: string, stepId: string): string | undefined
	clearFermentState(fermentId: string): void
}

export function createDefaultFermentRuntime(): FermentRuntime {
	return {
		getStorage,
		getActive,
		getActiveId,
		setActive,
		isAutoModeEnabled,
		setAutoModeEnabled,
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
		setCorrectiveStep,
		getCorrectiveStep,
		getPendingScope,
		setPendingScope,
		attachPendingPhases,
		clearPendingScope,
		clearAllPendingScopes,
		setPhaseStartRef,
		getPhaseStartRef,
		setStepStartRef,
		getStepStartRef,
		clearFermentState,
	}
}

export const defaultFermentRuntime = createDefaultFermentRuntime()
