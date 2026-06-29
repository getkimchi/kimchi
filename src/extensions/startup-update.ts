import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting, markAutoUpdateNoticeShown } from "../update/settings.js"
import { checkForUpdate, parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const UPDATE_STATUS_KEY = "update-available"

/**
 * Startup-time check for new kimchi versions. Uses cache (24h) and displays
 * a message on the status line (right side, centered) if an update is available.
 * Silently fails on errors to not block harness launch.
 *
 * The message is displayed via setStatus and read by the status line renderer.
 *
 * When auto-update is enabled (opt-in default — the toggle defaults to
 * off, so most users land here), the footer hint is suppressed — users
 * get updates silently on next launch. The first launch after a user
 * enables the toggle also emits a one-time onboarding toast explaining
 * the behavior and how to opt out via `/update`.
 */
export default function startupUpdateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return

		const current = getVersion()
		// Canary users opted into the canary track; don't nag them about
		// stable. Currency on canary is checked by `kimchi update --canary`.
		if (parseCanarySha7(current) !== null) return

		try {
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
		} catch (err) {
			// Settings layer broken (e.g. getAgentDir() throws, disk
			// unwritable). Don't crash the session — bail and let the
			// rest of the harness boot normally. Mirrors the swallow-
			// and-continue pattern used for checkForUpdate below, but
			// also returns early because we have no signal worth
			// showing when the settings file itself is unreadable.
			console.warn(`[startup-update] auto-update settings unavailable: ${(err as Error).message}`)
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
