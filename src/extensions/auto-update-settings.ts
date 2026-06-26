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

const AUTO_UPDATE_ON = (toggle: "on" | "off") => `Auto-update: ON (toggle ${toggle})`
const AUTO_UPDATE_OFF = (toggle: "on" | "off") => `Auto-update: OFF (toggle ${toggle})`

function autoUpdateLabel(): string {
	return loadAutoUpdateSetting() ? AUTO_UPDATE_ON("off") : AUTO_UPDATE_OFF("on")
}

async function showUpdateMenu(ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("Update", [autoUpdateLabel(), "Update kimchi now", "View current version", "Back"])
	if (!choice) return

	if (choice.startsWith("Auto-update:")) {
		const next = !loadAutoUpdateSetting()
		saveAutoUpdateSetting(next)
		ctx.ui.notify(`Auto-update set to ${next ? "on" : "off"}`, "info")
		// Loop so the user can flip it back without re-running /update.
		await showUpdateMenu(ctx)
		return
	}

	if (choice === "Update kimchi now") {
		const result = await runManualUpdate()
		ctx.ui.notify(result.message, result.ok ? "info" : "error")
		return
	}

	if (choice === "View current version") {
		ctx.ui.notify(`kimchi ${getVersion()}`, "info")
		return
	}

	// "Back" or anything else — exit the command.
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
