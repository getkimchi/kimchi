/**
 * `kimchi mcp import-auth` — one-shot import of pi-mcp-adapter OAuth
 * credentials into the native `mcp-auth.json` store, so upgrading to the
 * native MCP engine does not force a re-login per OAuth server.
 *
 * Reads the adapter stores read-only (keyring / legacy plaintext / opt-in
 * encrypted file) for every configured http server, converts the entries, and
 * writes native grants for servers that do not already have one. Adapter
 * stores are never modified — rolling back to v1.16.0 keeps its credentials.
 *
 * Usage: kimchi mcp import-auth [--json]
 * Exit:  0 on success (including "nothing to import"), 1 on failure
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import {
	type ImportAuthReport,
	type ImportServerResult,
	importAdapterAuth,
} from "../extensions/mcp/adapter-auth-import.js"

export function runImportAuth(args: string[], options: { agentDir?: string; cwd?: string } = {}): number {
	const json = args.includes("--json")
	const unknown = args.filter((arg) => arg !== "--json")
	if (unknown.length > 0) {
		return emitImportAuthFailure(
			`Unexpected argument(s): ${unknown.join(" ")}. Usage: kimchi mcp import-auth [--json]`,
			json,
		)
	}
	const agentDir = options.agentDir ?? getAgentDir()
	const cwd = options.cwd ?? process.cwd()
	try {
		return emitImportAuth(importAdapterAuth({ agentDir, cwd }), json)
	} catch (error) {
		return emitImportAuthFailure(error instanceof Error ? error.message : String(error), json)
	}
}

function emitImportAuth(report: ImportAuthReport, json: boolean): number {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	} else {
		const counts = countByStatus(report.results)
		process.stdout.write(
			`MCP OAuth import: ${report.imported.length} imported, ${counts["already-authenticated"]} already authenticated, ` +
				`${counts["no-adapter-credentials"]} without adapter credentials, ${counts["url-mismatch"] + counts["invalid-entry"]} stale/invalid.\n\n`,
		)
		printGroup(report.results, "imported", (r) => `  ${r.name} (${r.store})`)
		printGroup(report.results, "already-authenticated", (r) => `  ${r.name}`)
		printGroup(report.results, "no-adapter-credentials", (r) => `  ${r.name}`)
		printGroup(report.results, "url-mismatch", (r) => `  ${r.name}: ${r.detail ?? ""}`)
		printGroup(report.results, "invalid-entry", (r) => `  ${r.name}: ${r.detail ?? ""}`)
		if (report.imported.length > 0)
			process.stdout.write("\nAdapter stores were left untouched — rolling back to v1.16.0 keeps its credentials.\n")
	}
	for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`)
	return report.ok ? 0 : 1
}

function countByStatus(results: ImportServerResult[]): Record<ImportServerResult["status"], number> {
	const counts: Record<ImportServerResult["status"], number> = {
		imported: 0,
		"already-authenticated": 0,
		"no-adapter-credentials": 0,
		"url-mismatch": 0,
		"invalid-entry": 0,
	}
	for (const result of results) counts[result.status] += 1
	return counts
}

function printGroup(
	results: ImportServerResult[],
	status: ImportServerResult["status"],
	format: (result: ImportServerResult) => string,
): void {
	const group = results.filter((result) => result.status === status)
	if (group.length === 0) return
	const labels: Record<ImportServerResult["status"], string> = {
		imported: "Imported:",
		"already-authenticated": "Already authenticated natively (skipped):",
		"no-adapter-credentials": "No adapter credentials (sign in via kimchi mcp login <server>):",
		"url-mismatch": "Stale — the configured URL differs from the one the credentials were issued for:",
		"invalid-entry": "Stored credentials could not be parsed:",
	}
	process.stdout.write(`${labels[status]}\n`)
	for (const result of group) process.stdout.write(`${format(result)}\n`)
	process.stdout.write("\n")
}

function emitImportAuthFailure(message: string, json: boolean): number {
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
	} else {
		process.stderr.write(`${message}\n`)
	}
	return 1
}
