import type { Ferment, Phase } from "./types.js"

export function settleAfterPhaseTerminalPatch(phases: Phase[]): Pick<Ferment, "phases" | "status" | "activePhaseId"> {
	const activePhase = phases.find((p) => p.status === "active")
	if (activePhase) {
		return { phases, activePhaseId: activePhase.id, status: "running" }
	}
	return { phases, activePhaseId: undefined, status: "planned" }
}

export function settleAfterPhaseTerminal(ferment: Ferment, phases: Phase[], timestamp: string): Ferment {
	const activePhase = phases.find((p) => p.status === "active")
	if (activePhase) {
		return { ...ferment, status: "running", activePhaseId: activePhase.id, phases, updatedAt: timestamp }
	}
	const { activePhaseId: _activePhaseId, ...rest } = ferment
	return { ...rest, status: "planned", phases, updatedAt: timestamp }
}

export function activateSinglePhase(phases: Phase[], phaseId: string, timestamp: string): Phase[] {
	return phases.map((phase) => {
		if (phase.id === phaseId) {
			return {
				...phase,
				status: "active" as const,
				startedAt: timestamp,
				completedAt: undefined,
				summary: undefined,
				grade: undefined,
			}
		}
		if (phase.status === "active") return { ...phase, status: "planned" as const }
		return phase
	})
}
