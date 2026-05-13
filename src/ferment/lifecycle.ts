import type { Ferment, Stage } from "./types.js"

export function settleAfterStageTerminalPatch(stages: Stage[]): Pick<Ferment, "stages" | "status" | "activeStageId"> {
	const activeStage = stages.find((p) => p.status === "active")
	if (activeStage) {
		return { stages, activeStageId: activeStage.id, status: "running" }
	}
	return { stages, activeStageId: undefined, status: "planned" }
}

export function settleAfterStageTerminal(ferment: Ferment, stages: Stage[], timestamp: string): Ferment {
	const activeStage = stages.find((p) => p.status === "active")
	if (activeStage) {
		return { ...ferment, status: "running", activeStageId: activeStage.id, stages, updatedAt: timestamp }
	}
	const { activeStageId: _activeStageId, ...rest } = ferment
	return { ...rest, status: "planned", stages, updatedAt: timestamp }
}

export function activateSingleStage(stages: Stage[], stageId: string, timestamp: string): Stage[] {
	return stages.map((stage) => {
		if (stage.id === stageId) {
			return {
				...stage,
				status: "active" as const,
				startedAt: timestamp,
				completedAt: undefined,
				summary: undefined,
				grade: undefined,
			}
		}
		if (stage.status === "active") return { ...stage, status: "planned" as const }
		return stage
	})
}

// Backward-compat re-exports
/** @deprecated Use settleAfterStageTerminalPatch */
export const settleAfterPhaseTerminalPatch = settleAfterStageTerminalPatch
/** @deprecated Use settleAfterStageTerminal */
export const settleAfterPhaseTerminal = settleAfterStageTerminal
/** @deprecated Use activateSingleStage */
export const activateSinglePhase = activateSingleStage
