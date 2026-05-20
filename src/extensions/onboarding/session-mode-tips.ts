import type { Tip, TipProvider } from "../tips/types.js"

export const SESSION_MODE_TIP = {
	id: "choose-workflow",
	scope: "contextual",
	message: "Use `/ferment` anytime to start a Ferment workflow.",
} as const satisfies Tip

export function createSessionModeTipProvider(isPickerVisible: () => boolean): TipProvider {
	return {
		source: "kimchi.session-mode",
		getTips: () => (isPickerVisible() ? [SESSION_MODE_TIP] : []),
	}
}
