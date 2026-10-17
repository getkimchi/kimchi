/**
 * One-shot notices after the native-MCP migration:
 *
 * 1. Migration report — when `runNativeMcpMigration` (entry.ts, pre-boot)
 *    translated configs and recorded dropped adapter-only fields, show a
 *    one-time summary pointing at the report file. Marker: the report's
 *    `notifiedAt` field.
 * 2. OAuth re-login — the adapter kept its own credential stores (the
 *    `mcp-oauth/` directory, plus OS keychain entries that leave no file
 *    trace); native MCP keeps its own. Tokens are deliberately not migrated
 *    (user decision): any server named in both the adapter stores and the
 *    migrated global mcp.json gets a one-time "sign in again via /mcp"
 *    notice. Marker: `mcp-oauth-relogin-shown.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent"
import { MIGRATION_REPORT } from "./config-migration.js"

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function notifyMigrationReport(agentDir: string, ctx: ExtensionContext): void {
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
		// profile migration's outcome message). Only warn when something was
		// actually dropped; a clean migration stays silent.
		if (issues.length === 0) return
		const highlights = issues
			.slice(0, 5)
			.map((issue) => {
				if (!isRecord(issue) || typeof issue.message !== "string") return null
				const server = typeof issue.server === "string" ? `${issue.server}: ` : ""
				return `${server}${issue.message}`
			})
			.filter((line): line is string => line !== null)
		ctx.ui.notify(
			`MCP configs migrated to the native engine — ${issues.length} adapter-only entr${issues.length === 1 ? "y" : "ies"} could not be carried over (see ${reportPath}):\n${highlights.join("\n")}`,
			"warning",
		)
	} catch {
		// Never block startup on a notice.
	}
}

/**
 * Adapter-era OAuth server names, read from the adapter's on-disk traces:
 * `<agentDir>/mcp-oauth/<server>/` directories (macOS also kept tokens in the
 * OS keychain, which left no file trace — those grants surface as a 401 on
 * first use instead of a notice). The native store (`mcp-auth.json`) is NOT
 * a source: it belongs to the new engine and starts empty.
 */
function adapterOAuthServers(agentDir: string): Set<string> {
	const servers = new Set<string>()
	const oauthDir = join(agentDir, "mcp-oauth")
	if (existsSync(oauthDir) && statSync(oauthDir).isDirectory()) {
		for (const name of readdirSync(oauthDir)) {
			try {
				if (statSync(join(oauthDir, name)).isDirectory()) servers.add(name)
			} catch {
				// Unreadable entry — ignore.
			}
		}
	}
	return servers
}

function notifyOAuthRelogin(agentDir: string, ctx: ExtensionContext): void {
	try {
		const markerPath = join(agentDir, "mcp-oauth-relogin-shown.json")
		if (existsSync(markerPath)) return
		const oauthServers = adapterOAuthServers(agentDir)
		// The marker write can itself fail (e.g. an agent dir that does not
		// exist yet, as in headless test harnesses) — a notice must never block
		// startup, so the whole flow is best-effort.
		writeFileSync(markerPath, JSON.stringify({ shownAt: new Date().toISOString(), servers: [...oauthServers] }))
		if (oauthServers.size === 0) return
		const configPath = join(agentDir, "mcp.json")
		if (!existsSync(configPath)) return
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
		if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return
		const affected = Object.keys(parsed.mcpServers).filter((name) => oauthServers.has(name))
		if (affected.length === 0) return
		ctx.ui.notify(
			`MCP now uses the native engine, which keeps its own OAuth store. Sign in again for: ${affected.join(", ")} — run /mcp and choose "Sign in".`,
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
		notifyOAuthRelogin(agentDir, ctx)
	})
}
