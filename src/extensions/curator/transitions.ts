import type { AgentCreatedSkillReport, SkillState } from "../skills-manager/usage.js"
import { UsageTracker, agentCreatedReport } from "../skills-manager/usage.js"

const STALE_AFTER_DAYS = 30
const ARCHIVE_AFTER_DAYS = 90

export interface TransitionResult {
	proposeStale: string[]
	proposeArchive: string[]
	proposeReactivate: string[]
}

export function computeTransitions(entries: AgentCreatedSkillReport[], now: Date): TransitionResult {
	const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)
	const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000)

	const result: TransitionResult = { proposeStale: [], proposeArchive: [], proposeReactivate: [] }

	for (const row of entries) {
		if (row.pinned) continue

		const anchor = row.last_activity_at
			? new Date(row.last_activity_at)
			: row.created_at
				? new Date(row.created_at)
				: now

		if (anchor <= archiveCutoff && row.state !== "archived") {
			result.proposeArchive.push(row.name)
		} else if (anchor <= staleCutoff && row.state === "active") {
			result.proposeStale.push(row.name)
		} else if (anchor > staleCutoff && row.state === "stale") {
			result.proposeReactivate.push(row.name)
		}
	}

	return result
}

export async function runAutoTransitions(skillsDir: string, now: Date = new Date()): Promise<TransitionResult> {
	const entries = await agentCreatedReport(skillsDir)
	const result = computeTransitions(entries, now)

	const tracker = new UsageTracker(skillsDir)
	const changes: { name: string; state: SkillState }[] = [
		...result.proposeReactivate.map((name) => ({ name, state: "active" as const })),
		...result.proposeStale.map((name) => ({ name, state: "stale" as const })),
		...result.proposeArchive.map((name) => ({ name, state: "archived" as const })),
	]

	if (changes.length > 0) {
		await tracker.setStateBatch(changes)
	}

	return result
}
