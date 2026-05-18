import type { DeclarativeAction } from "../../ferment/engine.js"

export function publicToolNameForActionKind(kind: DeclarativeAction["kind"]): string {
	switch (kind) {
		case "activate_phase":
			return "activate_ferment_phase"
		case "refine":
			return "refine_ferment_phase"
		case "start_step":
			return "start_ferment_step"
		case "complete_step":
			return "complete_ferment_step"
		case "verify_step":
			return "verify_ferment_step"
		case "complete_phase":
			return "complete_ferment_phase"
		default:
			return kind
	}
}

export function formatActionNudgeLine(action: DeclarativeAction): string {
	return `${publicToolNameForActionKind(action.kind)}: ${action.reason}`
}
