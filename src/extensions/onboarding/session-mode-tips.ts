import type { Tip, TipProvider } from "../tips/types.js"

export const SESSION_MODE_TIP = {
	id: "choose-session-mode",
	scope: "contextual",
	message: "You can start a ferment session with `/ferment` anytime.",
} as const satisfies Tip

export function createSessionModeTipProvider(isPickerVisible: () => boolean): TipProvider {
	return {
		source: "kimchi.session-mode",
		getTips: () => (isPickerVisible() ? [SESSION_MODE_TIP] : []),
	}
}
