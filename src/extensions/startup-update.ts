import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting, markAutoUpdateNoticeShown } from "../update/settings.js"
import { checkForUpdate, parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const UPDATE_STATUS_KEY = "update-available"

/**
 * Startup-time check for new kimchi versions. Uses cache (24h) and displays
 * a message on the footer (right side, centered) if an update is available.
 * Silently fails on errors to not block harness launch.
 *
 * The message is displayed via setStatus and read by the footer renderer.
 *
 * When auto-update is enabled (default-on), the footer hint is suppressed —
 * users get updates silently on next launch. The first launch after this
 * ships also emits a one-time onboarding toast explaining the new behavior
 * and how to opt out via `/update`.
 */
export default function startupUpdateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return

		const current = getVersion()
		// Canary users opted into the canary track; don't nag them about
		// stable. Currency on canary is checked by `kimchi update --canary`.
		if (parseCanarySha7(current) !== null) return

		const autoUpdateEnabled = loadAutoUpdateSetting()
		if (autoUpdateEnabled) {
			// Auto-update is on: no nag (next launch applies silently).
			// First launch only: explain the new behavior and how to opt out.
			if (!loadAutoUpdateNoticeShown()) {
				ctx.ui.notify("kimchi now updates itself in the background. Run `/update` to disable.")
				markAutoUpdateNoticeShown()
			}
			return
		}

		try {
			const result = await checkForUpdate({ currentVersion: current, skipCache: false })
			if (result.hasUpdate) {
				const updateCmd = ctx.ui.theme.bold(isHomebrewInstall() ? "brew upgrade kimchi" : "kimchi update")
				ctx.ui.setStatus(UPDATE_STATUS_KEY, `Update available! Run ${updateCmd}`)
			}
		} catch {
			// Silently ignore errors - don't block harness launch
		}
	})
}
