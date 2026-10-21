import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { IS_ACP_MODE } from "../modes/acp/state.js"
import { isHomebrewInstall } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting, markAutoUpdateNoticeShown } from "../update/settings.js"
import { checkForUpdate, parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const UPDATE_STATUS_KEY = "update-available"
const AUTO_UPDATE_NOTICE_ENTRY = "auto-update-notice"

export const AUTO_UPDATE_NOTICE =
	"Auto-update is now on by default: from the next launch, kimchi installs new versions in the background when it starts. Run `/update` to turn it off."

/**
 * Startup-time check for new kimchi versions. Uses cache (24h) and displays
 * a message on the status line (right side, centered) if an update is available.
 * Silently fails on errors to not block harness launch.
 *
 * The message is displayed via setStatus and read by the status line renderer.
 *
 * When auto-update is enabled (opt-out default — the toggle defaults
 * to on, so most users land here), the footer hint is suppressed — users
 * get updates silently on next launch. The first launch with the toggle
 * on also emits a one-time announcement of the default change and how to
 * opt out via `/update` — a persistent transcript entry in the TUI (the
 * notify() toast would auto-dismiss). The launch auto-update
 * (auto-update.ts) waits for this announcement, so upgraded users hear
 * about it before their first update.
 *
 * ACP sessions neither show nor mark the announcement: the launch
 * auto-update never runs in protocol modes — ACP clients (e.g. Studio)
 * own harness updates themselves — so a "updates on next launch" notice
 * would be false there. Leaving the flag unmarked also keeps the accurate
 * TUI notice pending for the user's first TUI session.
 */
export default function startupUpdateExtension(pi: ExtensionAPI) {
	// A custom entry stays visible in the transcript (notify() is a
	// transient toast that auto-dismisses) and stays out of model context.
	pi.registerEntryRenderer<string>(AUTO_UPDATE_NOTICE_ENTRY, (entry, _options, theme) =>
		typeof entry.data === "string" ? new Text(theme.fg("dim", entry.data), 1, 0) : undefined,
	)

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return

		const current = getVersion()
		// Canary users opted into the canary track; don't nag them about
		// stable. Currency on canary is checked by `kimchi update --canary`.
		if (parseCanarySha7(current) !== null) return

		try {
			const autoUpdateEnabled = loadAutoUpdateSetting()
			// Only suppress the footer nag when on-launch auto-update can
			// actually run. Homebrew installs are skipped by the launch
			// auto-update path (see auto-update.ts), so a Homebrew user with
			// autoUpdate=true would otherwise get neither a background update
			// nor the `brew upgrade kimchi` hint.
			if (autoUpdateEnabled && !isHomebrewInstall()) {
				// Auto-update is on: no nag (next launch applies silently).
				// First TUI launch only: announce the default change and how to
				// opt out. Excluded in ACP (see the extension comment above) —
				// IS_ACP_MODE is checked first so ACP sessions never even read
				// the notice flag.
				if (!IS_ACP_MODE && !loadAutoUpdateNoticeShown()) {
					pi.appendEntry(AUTO_UPDATE_NOTICE_ENTRY, AUTO_UPDATE_NOTICE)
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
				// Homebrew-managed installs live outside kimchi's swap path —
				// point the user at `brew upgrade` rather than `kimchi update`.
				const updateCmd = ctx.ui.theme.bold(isHomebrewInstall() ? "brew upgrade kimchi" : "kimchi update")
				ctx.ui.setStatus(UPDATE_STATUS_KEY, `Update available! Run ${updateCmd}`)
			}
		} catch {
			// Silently ignore errors - don't block harness launch
		}
	})
}
