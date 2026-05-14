import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { checkForUpdate, parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const UPDATE_STATUS_KEY = "update-available"

/**
 * Startup-time check for new kimchi versions. Uses cache (24h) and displays
 * a message on the footer (right side, centered) if an update is available.
 * Silently fails on errors to not block harness launch.
 *
 * The message is displayed via setStatus and read by the footer renderer.
 */
export default function startupUpdateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return

		const current = getVersion()
		// Canary users opted into the canary track; don't nag them about
		// stable. Currency on canary is checked by `kimchi update --canary`.
		if (parseCanarySha7(current) !== null) return
		try {
			const result = await checkForUpdate({ currentVersion: current, skipCache: false })
			if (result.hasUpdate) {
				const updateCmd = ctx.ui.theme.bold(isHomebrewInstall() ? "brew upgrade kimchi-dev" : "kimchi update")
				ctx.ui.setStatus(UPDATE_STATUS_KEY, `Update available! Run ${updateCmd}`)
			}
		} catch {
			// Silently ignore errors - don't block harness launch
		}
	})
}
