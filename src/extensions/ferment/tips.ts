import type { Ferment } from "../../ferment/types.js"
import type { Tip, TipProvider } from "../tips/types.js"
import type { FermentRuntime } from "./runtime.js"

export const FERMENT_TIPS = {
	continuationPolicy: {
		id: "continuation-policy",
		scope: "contextual",
		message: "Use `/ferment auto` to keep going; `/ferment manual` stops at phase boundaries.",
	},
	progressNavigation: {
		id: "progress-navigation",
		scope: "contextual",
		message: "Open Ferment progress with `/ferment progress`.",
	},
	switchFerments: {
		id: "switch-ferments",
		scope: "contextual",
		message: "Switch active Ferments with `/ferment switch <name>`.",
	},
	pauseResume: {
		id: "pause-resume",
		scope: "contextual",
		message: "Pause work with `/ferment pause`; resume with `/ferment resume`.",
	},
	reviewWork: {
		id: "review-work",
		scope: "contextual",
		message: "Review completed work with `/ferment progress`.",
	},
	startFerment: {
		id: "start-ferment",
		scope: "general",
		message: "Run `/ferment` to start or list Ferments.",
	},
} as const satisfies Record<string, Tip>

export function getFermentTips(ferment: Ferment | undefined): readonly Tip[] {
	if (!ferment) return []

	switch (ferment.status) {
		case "draft":
		case "planned":
			return [FERMENT_TIPS.continuationPolicy, FERMENT_TIPS.progressNavigation, FERMENT_TIPS.switchFerments]
		case "running":
			return [FERMENT_TIPS.progressNavigation, FERMENT_TIPS.pauseResume, FERMENT_TIPS.switchFerments]
		case "paused":
			return [FERMENT_TIPS.pauseResume, FERMENT_TIPS.progressNavigation, FERMENT_TIPS.switchFerments]
		case "complete":
			return [FERMENT_TIPS.reviewWork, FERMENT_TIPS.progressNavigation]
		case "abandoned":
			return [FERMENT_TIPS.startFerment]
	}
}

export function createFermentTipProvider(runtime: Pick<FermentRuntime, "getActive">): TipProvider {
	return {
		source: "kimchi.ferment",
		getTips: () => getFermentTips(runtime.getActive()),
	}
}
