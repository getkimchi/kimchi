import type { Tip, TipProvider } from "../tips/types.js"
import { isHomebrewInstall } from "../../update/paths.js"
import { loadAutoUpdateSetting } from "../../update/settings.js"

const AUTO_UPDATE_TIP: Tip = {
	id: "enable-auto-update",
	scope: "general",
	message: "Run `/update` to enable auto-update so kimchi stays up to date automatically.",
}

/**
 * Tip provider that surfaces an "enable auto-update" tip in the TUI tips
 * rotation whenever auto-update is disabled (and the install is eligible —
 * not Homebrew, not disabled by env var).
 */
export function createAutoUpdateTipProvider(): TipProvider {
	return {
		source: "kimchi.auto-update",
		getTips: () => {
			if (process.env.KIMCHI_NO_UPDATE_CHECK) return []
			if (isHomebrewInstall()) return []
			if (loadAutoUpdateSetting()) return []
			return [AUTO_UPDATE_TIP]
		},
	}
}
