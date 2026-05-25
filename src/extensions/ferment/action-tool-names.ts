import type { DeclarativeAction } from "../../ferment/engine.js"
import { FERMENT_TOOLS } from "./tool-names.js"

export function publicToolNameForActionKind(kind: DeclarativeAction["kind"]): string {
	switch (kind) {
		case "activate_phase":
			return FERMENT_TOOLS.ACTIVATE_PHASE
		case "refine":
			return FERMENT_TOOLS.REFINE_PHASE
		case "start_step":
			return FERMENT_TOOLS.START_STEP
		case "complete_step":
			return FERMENT_TOOLS.COMPLETE_STEP
		case "verify_step":
			return FERMENT_TOOLS.VERIFY_STEP
		case "complete_phase":
			return FERMENT_TOOLS.COMPLETE_PHASE
		default:
			return kind
	}
}

export function formatActionNudgeLine(action: DeclarativeAction): string {
	return `${publicToolNameForActionKind(action.kind)}: ${action.reason}`
}
