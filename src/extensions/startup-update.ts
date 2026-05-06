import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { checkForUpdate } from "../update/workflow.js"
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
		try {
			const result = await checkForUpdate({ currentVersion: current, skipCache: false })
			if (result.hasUpdate) {
				const updateCmd = ctx.ui.theme.bold("kimchi update")
				ctx.ui.setStatus(UPDATE_STATUS_KEY, `Update available! Run ${updateCmd}`)
			}
		} catch {
			// Silently ignore errors - don't block harness launch
		}
	})
}
