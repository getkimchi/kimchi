/**
 * `kimchi documents doctor [--json]` — per-target self-check for the
 * documents capability (modelled on `kimchi mcp keyring-check`). Ignores the
 * experimental toggles: CI and support need it on any install.
 */

import { runDoctor } from "../extensions/documents/doctor.js"

export async function runDocuments(args: string[]): Promise<number> {
	const subcommand = args[0]
	if (subcommand !== "doctor") {
		process.stderr.write("Usage: kimchi documents doctor [--json]\n")
		return 1
	}
	const report = await runDoctor()
	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	} else {
		for (const check of report.checks) {
			process.stdout.write(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}\n`)
		}
		if (report.assetSource) process.stdout.write(`assets: ${report.assetSource}\n`)
		process.stdout.write(`documents doctor: ${report.ok ? "ok" : "FAILED"}\n`)
	}
	return report.ok ? 0 : 1
}
