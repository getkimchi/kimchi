import { createMemoryRecords } from "../pr-cost-reporting/ledger/memory-records.js"
import { readWorkSummary, seedProjectionRows, useBackendFactory } from "../pr-cost-reporting/ledger/records.js"
import type { Collection, Row, WorkSummaryView } from "../work-attribution/row-log.js"

// Node/vitest cannot load bun:sqlite. Every suite that seeds through this fixture mock
// runs on the in-memory backend — the same contract the shared conformance suite asserts.
useBackendFactory(() => createMemoryRecords())

/** Fixture views only need the fields under test; missing collections fold as empty. */
export type WorkSummaryFixture = { workId: string; sessions?: string[] } & Partial<Record<Collection, Row[]>>

/**
 * Seeds a work's derived projection directly from a summary view; the old fixture wrote work.json/row-log
 * files instead. Tests that also capture records simply get their seeded rows folded alongside.
 */
export function saveWorkSummary(agentDir: string, view: WorkSummaryFixture): void {
	seedProjectionRows(agentDir, {
		workId: view.workId,
		sessions: view.sessions ?? [],
		workLinks: view.workLinks ?? [],
		requests: view.requests ?? [],
		plans: view.plans ?? [],
		commits: view.commits ?? [],
		fileTransitions: view.fileTransitions ?? [],
		fileObservations: view.fileObservations ?? [],
		continuations: view.continuations ?? [],
	})
}

/** The work's saved derived view; throws when nothing was captured or seeded. */
export function savedWorkSummary(agentDir: string, workId: string): WorkSummaryView {
	const view = readWorkSummary(agentDir, workId)
	if (!view) throw new Error(`No saved work summary for ${workId}`)
	return view
}
