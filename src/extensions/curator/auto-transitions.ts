import { homedir } from "node:os"
import { join } from "node:path"
import { STATE_ACTIVE, STATE_ARCHIVED, STATE_STALE, agentCreatedReport } from "../skills-manager/usage.js"
import type { TransitionProposal } from "./types.js"

const STALE_AFTER_DAYS = 30
const ARCHIVE_AFTER_DAYS = 90

/**
 * Computes auto-transition proposals based on skill activity timestamps.
 *
 * This function does NOT mutate anything - it only computes what SHOULD happen.
 *
 * Logic:
 * - If skill last_activity > 90 days ago → proposeArchive
 * - If skill last_activity > 30 days ago → proposeStale
 * - If skill was stale and has recent activity → proposeReactivate
 * - Pinned skills are NEVER proposed for any transition
 *
 * @param now - The reference date for calculations (defaults to now)
 * @param skillsDir - Directory containing skill data (defaults to user config)
 */
export async function applyAutoTransitions(
	now: Date = new Date(),
	skillsDir: string = join(homedir(), ".config", "kimchi", "harness", "skills"),
): Promise<TransitionProposal> {
	const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)
	const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000)

	const result: TransitionProposal = {
		checked: [],
		proposeStale: [],
		proposeArchive: [],
		proposeReactivate: [],
	}

	const rows = await agentCreatedReport(skillsDir)

	for (const row of rows) {
		result.checked.push(row.name)

		// Pinned skills are never proposed for any transition
		if (row.pinned) continue

		const lastActivity = row.last_activity_at ? new Date(row.last_activity_at) : null
		const anchor = lastActivity || (row.created_at ? new Date(row.created_at) : now)

		const current = row.state

		if (anchor <= archiveCutoff && current !== STATE_ARCHIVED) {
			result.proposeArchive.push(row.name)
		} else if (anchor <= staleCutoff && current === STATE_ACTIVE) {
			result.proposeStale.push(row.name)
		} else if (anchor > staleCutoff && current === STATE_STALE) {
			result.proposeReactivate.push(row.name)
		}
	}

	return result
}
