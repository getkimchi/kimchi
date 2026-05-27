/**
 * Report Bug Extension
 *
 * Registers the /reportbug slash command that opens the GitHub issue form
 * for kimchi harness bug reports.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import open from "open"
import { getVersion } from "../utils.js"

const GITHUB_ISSUES_BASE = "https://github.com/getkimchi/kimchi/issues/new"

const BUG_COMMAND_CONFIG = {
	description: "Report a bug in kimchi — opens GitHub issue form",
	handler: async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim()
		const version = getVersion()

		const params = new URLSearchParams({
			template: "bug_report.yml",
			labels: "bug",
			version,
			...(trimmed ? { title: trimmed, description: trimmed } : {}),
		})

		const url = `${GITHUB_ISSUES_BASE}?${params.toString()}`

		if (ctx.hasUI) {
			ctx.ui.notify("Opening GitHub issues page for bug report...", "info")
			try {
				await open(url)
			} catch {
				ctx.ui.notify(`Failed to open browser. Manually open: ${url}`, "error")
			}
		} else {
			console.log(`Bug report: ${url}`)
			console.log("Open this URL in your browser to file a bug report.")
		}
	},
}

export default function reportBugExtension(pi: ExtensionAPI) {
	pi.registerCommand("reportbug", BUG_COMMAND_CONFIG)
	pi.registerCommand("bug", BUG_COMMAND_CONFIG)
}
