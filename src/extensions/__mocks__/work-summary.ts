import { readWorkSummary, type WorkSummaryView } from "../work-attribution/row-log.js"

/** A work's saved summary in the version 1 shape; fails the test when it is missing or damaged. */
export function savedWorkSummary(agentDir: string, workId: string): WorkSummaryView {
	const summary = readWorkSummary(agentDir, workId)
	if (!summary) throw new Error(`No readable work summary for ${workId}`)
	return summary
}
