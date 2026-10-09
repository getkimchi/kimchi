/**
 * Reads a work's local summary the way docs/work-attribution.md describes it, independently of the product reader.
 * Version 1 `work.json` holds every row. Version 2 `work.json` is a manifest whose `logs` name
 * `rows/<collection>.<generation>.jsonl`; only the first `bytes` of each log are committed, and a later row with the
 * same key replaces an earlier one in place.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Row = Record<string, unknown>

const KEYS: Record<string, (row: Row) => string> = {
	workLinks: (row) =>
		JSON.stringify([
			row.linkId,
			row.revision,
			row.sourceWorkId,
			row.targetWorkId,
			row.requestIds,
			row.scope,
			row.status,
			row.evidence,
		]),
	requests: (row) => JSON.stringify(row.requestId),
	plans: (row) => JSON.stringify([row.sessionId, row.path, row.snapshotPath]),
	commits: (row) => JSON.stringify([row.sessionId, row.sha, row.repository, row.worktree]),
	fileTransitions: (row) => JSON.stringify(row.transitionId),
	fileObservations: (row) => JSON.stringify(row.observationId),
	continuations: (row) => JSON.stringify([row.sessionId, row.source, row.evidence]),
}

/** The summary in the version 1 shape, or undefined while it is missing or a writer is replacing a log. */
export function readWorkSummary(agentDir: string, workId: string): Record<string, Row[] | unknown> | undefined {
	const folder = join(agentDir, "work", workId)
	try {
		const manifest = JSON.parse(readFileSync(join(folder, "work.json"), "utf8"))
		if (manifest.version !== 2) return manifest
		const view: Record<string, Row[] | unknown> = { version: 1, workId: manifest.workId, sessions: manifest.sessions }
		for (const [collection, key] of Object.entries(KEYS)) {
			const log = manifest.logs[collection]
			const rows = new Map<string, Row>()
			if (log) {
				const text = readFileSync(join(folder, "rows", `${collection}.${log.generation}.jsonl`))
					.subarray(0, log.bytes)
					.toString("utf8")
				for (const line of text.split("\n")) {
					if (!line) continue
					const row = JSON.parse(line)
					rows.set(key(row), row)
				}
			}
			view[collection] = [...rows.values()]
		}
		return view
	} catch {
		return undefined
	}
}
