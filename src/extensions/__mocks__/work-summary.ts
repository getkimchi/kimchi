import { join } from "node:path"
import {
	COLLECTIONS,
	type Collection,
	ROW_KEYS,
	type Row,
	readWorkSummary,
	updateWorkRows,
	type WorkSummaryView,
} from "../work-attribution/row-log.js"

/** A work's saved rows, folded from its logs; fails the test when the summary is missing or damaged. */
export function savedWorkSummary(agentDir: string, workId: string): WorkSummaryView {
	const summary = readWorkSummary(agentDir, workId)
	if (!summary) throw new Error(`No readable work summary for ${workId}`)
	return summary
}

/** Saves rows as the summary of a work that has none yet, as the writer commits merged records. */
export async function saveWorkSummary(
	agentDir: string,
	{ workId, sessions, ...rows }: Pick<WorkSummaryView, "workId" | "sessions"> & Partial<Record<Collection, Row[]>>,
): Promise<void> {
	await updateWorkRows(
		join(agentDir, "work", workId),
		workId,
		{ check: () => true, assertLease: () => {} },
		async (summary) => {
			for (const sessionId of sessions) summary.sessions.add(sessionId)
			for (const collection of COLLECTIONS)
				for (const row of rows[collection] ?? []) summary[collection].set(ROW_KEYS[collection](row), row)
		},
	)
}
