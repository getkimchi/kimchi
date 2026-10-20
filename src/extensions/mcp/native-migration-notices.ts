/**
 * One-shot notice after the native-MCP migration: when `runNativeMcpMigration`
 * (entry.ts, pre-boot) translated configs and recorded dropped adapter-only
 * fields, show a single-line summary pointing at the report file and backups.
 * Field-level detail stays in the report — users cannot act on it and pi's
 * own "MCP servers need attention" banner already covers anything that fails
 * at runtime. Marker: the report's `notifiedAt` field.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { MIGRATION_REPORT } from "./config-migration.js"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function notifyMigrationReport(agentDir: string, ctx: ExtensionContext): void {
	const reportPath = join(agentDir, MIGRATION_REPORT)
	if (!existsSync(reportPath)) return
	try {
		const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"))
		if (!isRecord(report) || report.notifiedAt !== undefined) return
		const issues = Array.isArray(report.issues) ? report.issues : []
		report.notifiedAt = new Date().toISOString()
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
		// Info-type notices use pi's coalescing status slot: an info notify at
		// session_start silently replaces other startup notifies (e.g. the shell
		// profile migration's outcome message). Only notify when something was
		// actually dropped; a clean migration stays silent.
		if (issues.length === 0) return
		ctx.ui.notify(
			`MCP configs migrated to the native engine — ${issues.length} adapter-only setting${issues.length === 1 ? "" : "s"} not carried over. Report: ${reportPath} (originals: *.pre-native-migration.bak)`,
			"info",
		)
	} catch {
		// Never block startup on a notice.
	}
}

export default function nativeMcpMigrationNoticesExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return
		let agentDir: string
		try {
			agentDir = getAgentDir()
		} catch {
			return
		}
		notifyMigrationReport(agentDir, ctx)
	})
}
