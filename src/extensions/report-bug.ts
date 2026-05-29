/**
 * Report Bug Extension
 *
 * Registers the /bug slash command that opens the GitHub issue form
 * for kimchi harness bug reports.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import open from "open"
import { getVersion } from "../utils.js"

const GITHUB_ISSUES_BASE = "https://github.com/getkimchi/kimchi/issues/new"

async function createSessionGist(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const { execFileSync } = await import("node:child_process")
	try {
		const sessionFile = ctx.sessionManager.getSessionFile()
		if (!sessionFile) {
			return undefined
		}
		const result = execFileSync("gh", ["gist", "create", "--public=false", sessionFile], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30000,
		})
		const lines = result
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
		// gh outputs the gist URL on the last non-empty line
		const gistUrl = lines.at(-1)
		if (!gistUrl || !gistUrl.startsWith("https://")) {
			throw new Error(`Unexpected gh output: ${result}`)
		}
		return gistUrl
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (ctx.hasUI) {
			ctx.ui.notify(`Failed to create gist: ${message}`, "error")
		} else {
			console.error("Failed to create gist:", message)
		}
		return undefined
	}
}

const BUG_COMMAND_CONFIG = {
	description: "Report a bug in kimchi — opens GitHub issue form",
	handler: async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim()
		const version = getVersion()

		let gistUrl: string | undefined
		if (ctx.hasUI) {
			const includeGist = await ctx.ui.confirm(
				"Include session export",
				"Would you like to include a session export as a GitHub gist in the bug report?",
			)
			if (includeGist) {
				gistUrl = await createSessionGist(ctx)
			}
		}

		const params = new URLSearchParams({
			template: "bug_report.yml",
			labels: "bug",
			version,
			...(trimmed ? { title: trimmed, description: trimmed } : {}),
		})

		if (gistUrl) {
			params.set("session-file", gistUrl)
		}

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
	pi.registerCommand("bug", BUG_COMMAND_CONFIG)
}
