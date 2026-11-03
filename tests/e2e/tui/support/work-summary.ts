/** Node E2E readers use the existing Bun driver for the production SQLite store. */
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { WorkSummaryView } from "../../../../src/extensions/work-attribution/row-log.js"
import type { WorkRecord } from "../../../../src/extensions/work-attribution/summary.js"

// tui-test relocates bundled helpers into .tui-test/cache; its runner supplies the original repository root.
const DRIVER = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT, "tests/e2e/tui/support/ledger-driver.ts")
	: fileURLToPath(new URL("./ledger-driver.ts", import.meta.url))

function ledger(agentDir: string, command: string, arg?: string): unknown {
	const output = execFileSync("bun", [DRIVER, command, agentDir, ...(arg === undefined ? [] : [arg])], {
		encoding: "utf8",
		timeout: 15_000,
	})
	return JSON.parse(output.trim())
}

/** Includes read-only legacy hydration, so intentional old-install fixtures keep their meaning. */
export function readWorkRecords(agentDir: string): WorkRecord[] {
	return ledger(agentDir, "read-work-records") as WorkRecord[]
}

/** Every committed projection row, or undefined while the work has no projection yet. */
export function readWorkSummary(agentDir: string, workId: string): WorkSummaryView | undefined {
	return (ledger(agentDir, "rows", workId) as WorkSummaryView | null) ?? undefined
}

/** Tracker notes are inspected separately from projections to preserve privacy assertions. */
export function readWorkNote(agentDir: string, workId: string, name: string): string | undefined {
	return (ledger(agentDir, "note", JSON.stringify([workId, name])) as string | null) ?? undefined
}

/** Test-only storage-loss injection; immutable authority records are never removed. */
export function removeWorkNote(agentDir: string, workId: string, name: string): void {
	ledger(agentDir, "remove-note", JSON.stringify([workId, name]))
}
