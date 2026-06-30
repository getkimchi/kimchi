/**
 * kimchi `/update` slash command — exposes the auto-update toggle and a
 * manual "update now" action in the TUI.
 *
 * The auto-update-on-launch decision lives in src/update/auto-update.ts
 * (Phase 2) and runs headlessly before the TUI boots. This command is the
 * user-facing surface for the same settings: flip the toggle, kick off a
 * one-shot update, or just see the running version.
 *
 * Mirrors the `agents/index.ts:showSettings()` pattern: registerCommand
 * + ctx.ui.select menu + ctx.ui.notify feedback.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { loadAutoUpdateSetting, saveAutoUpdateSetting } from "../update/settings.js"
import { applyUpdate, checkForUpdate } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const LOG_PREFIX = "[kimchi-auto-update]"

// Re-export pure helpers so tests can drive them without booting the TUI.
export { argvHasSkipTrigger } from "../update/auto-update.js"
export {
	loadAutoUpdateSetting,
	saveAutoUpdateSetting,
	loadAutoUpdateNoticeShown,
	markAutoUpdateNoticeShown,
} from "../update/settings.js"

export interface ManualUpdateResult {
	ok: boolean
	message: string
}

/**
 * Run a one-shot update check + apply. Used by the `/update` command's
 * "Update kimchi now" menu item and exported for tests. We deliberately
 * skip the 24h cache (`skipCache: true`) because the user explicitly
 * asked to check.
 *
 * Never throws — both `checkForUpdate` and `applyUpdate` failures are
 * captured into the returned `{ ok, message }` payload.
 */
export async function runManualUpdate(): Promise<ManualUpdateResult> {
	try {
		const check = await checkForUpdate({
			currentVersion: getVersion(),
			skipCache: true,
			canary: false,
		})
		if (!check.hasUpdate) {
			return { ok: true, message: `Already up to date (${getVersion()})` }
		}
		try {
			await applyUpdate({ tag: check.tag })
			return { ok: true, message: `Updated to ${check.latestVersion}. Restart your terminal.` }
		} catch (err) {
			const message = (err as Error).message
			process.stderr.write(`${LOG_PREFIX} manual update failed: ${message}\n`)
			return { ok: false, message: `Update failed: ${message}` }
		}
	} catch (err) {
		const message = (err as Error).message
		process.stderr.write(`${LOG_PREFIX} update check failed: ${message}\n`)
		return { ok: false, message: `Update check failed: ${message}` }
	}
}

// Single source of truth for the auto-update menu item label. The same
// prefix is matched against in showUpdateMenu below — keep both in sync
// if you ever rename the visible text. ctx.ui.select in pi-coding-agent
// only accepts string[] options (no separate id field), so we can't
// fully decouple display text from branch identity.
const AUTO_UPDATE_LABEL_PREFIX = "Auto-update:"

const AUTO_UPDATE_ON = (toggle: "on" | "off") => `${AUTO_UPDATE_LABEL_PREFIX} ON (toggle ${toggle})`
const AUTO_UPDATE_OFF = (toggle: "on" | "off") => `${AUTO_UPDATE_LABEL_PREFIX} OFF (toggle ${toggle})`

function autoUpdateLabel(): string {
	return loadAutoUpdateSetting() ? AUTO_UPDATE_ON("off") : AUTO_UPDATE_OFF("on")
}

const UPDATE_NOW_LABEL = "Update kimchi now"

/**
 * Cheap "is an update available?" probe for deciding whether to show the
 * "Update kimchi now" menu item. Uses the cached check (no `skipCache`) so
 * opening `/update` doesn't block on the network, and never throws — a
 * failed/disabled check simply hides the item.
 */
async function updateAvailable(): Promise<boolean> {
	try {
		const check = await checkForUpdate({ currentVersion: getVersion(), canary: false })
		return check.hasUpdate
	} catch {
		return false
	}
}

async function showUpdateMenu(ctx: ExtensionCommandContext): Promise<void> {
	// Only offer "Update kimchi now" when there's actually something to
	// install; otherwise it's a no-op that reports "Already up to date".
	const canUpdate = await updateAvailable()

	while (true) {
		const options = [...(canUpdate ? [UPDATE_NOW_LABEL] : []), autoUpdateLabel(), "View current version", "Back"]
		const choice = await ctx.ui.select("Update", options)
		if (!choice) return

		if (choice === UPDATE_NOW_LABEL) {
			const result = await runManualUpdate()
			ctx.ui.notify(result.message, result.ok ? "info" : "error")
			return
		}

		if (choice.startsWith(AUTO_UPDATE_LABEL_PREFIX)) {
			const next = !loadAutoUpdateSetting()
			saveAutoUpdateSetting(next)
			ctx.ui.notify(`Auto-update set to ${next ? "on" : "off"}`, "info")
			// Loop so the user can flip it back without re-running /update.
			continue
		}

		if (choice === "View current version") {
			ctx.ui.notify(`kimchi ${getVersion()}`, "info")
			return
		}

		// "Back" or anything else — exit the command.
		return
	}
}

export default function autoUpdateSettingsExtension(pi: ExtensionAPI) {
	pi.registerCommand("update", {
		description: "Manage kimchi auto-update",
		handler: async (_args, ctx) => {
			// Only the TUI shows the menu. Headless modes already have
			// `kimchi update` as their escape hatch.
			if (ctx.mode !== "tui") return

			if (process.env.KIMCHI_NO_UPDATE_CHECK) {
				ctx.ui.notify("Updates are disabled by the KIMCHI_NO_UPDATE_CHECK environment variable.", "info")
				return
			}

			if (isHomebrewInstall()) {
				ctx.ui.notify(
					"kimchi is managed by Homebrew; auto-update is not available. Run `brew upgrade kimchi` instead.",
					"info",
				)
				return
			}

			await showUpdateMenu(ctx)
		},
	})
}
