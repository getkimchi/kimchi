import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readConfigSetting, writeConfigSetting } from "../config/settings.js"
import { findShellProfileApiKey, removeShellProfileApiKey } from "../config/shell-profile.js"

const DISMISSED_SETTING = "shellProfileApiKeyMigrationDismissed"

export default function shellProfileMigrationExtension(pi: ExtensionAPI): void {
	let checked = false
	pi.on("session_start", async (event, ctx) => {
		if (checked || event.reason !== "startup" || !ctx.hasUI || ctx.mode !== "tui") return
		checked = true
		if (readConfigSetting(DISMISSED_SETTING, (value) => typeof value === "boolean", false)) return

		try {
			const profile = findShellProfileApiKey()
			if (!profile) return
			if (!profile.canRemove) {
				const example = profile.shell === "fish" ? "set -gx KIMCHI_API_KEY ..." : "export KIMCHI_API_KEY=..."
				const choice = await ctx.ui.select(
					[
						`Possible old API key in ${profile.path}`,
						"",
						"Kimchi couldn't safely clean up this profile automatically.",
						"",
						`Open ${profile.path} and look for:`,
						`  ${example}`,
						"",
						"Remove it if it's your old key export.",
					].join("\n"),
					["OK", "Don't ask again"],
				)
				if (choice === "Don't ask again") writeConfigSetting(DISMISSED_SETTING, true)
				return
			}
			const choice = await ctx.ui.select(
				`We detected KIMCHI_API_KEY in your shell profile. Do you want to remove it?\n${profile.path}`,
				["Yes", "No", "No, don't ask again"],
			)
			if (choice === "No, don't ask again") {
				writeConfigSetting(DISMISSED_SETTING, true)
			} else if (choice === "Yes") {
				removeShellProfileApiKey(profile)
				ctx.ui.notify(
					`Removed KIMCHI_API_KEY from ${profile.path}. Already-open shells keep their current environment.`,
					"info",
				)
			}
		} catch (error) {
			ctx.ui.notify(
				`Shell profile migration failed: ${error instanceof Error ? error.message : "Unable to update shell profile or settings."}`,
				"warning",
			)
		}
	})
}
