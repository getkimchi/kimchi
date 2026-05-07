import { archiveSkill, skillExists } from "../skills-manager/skill-manager.js"
import { STATE_ACTIVE, STATE_STALE, setStateBatch } from "../skills-manager/usage.js"
import type { CuratorReport, ExecutionResult } from "./types.js"

/**
 * Execute a curator report in two phases:
 * - Phase A: Atomic mechanical operations (reactivate, stale, archive) — fail-fast
 * - Phase B: Best-effort LLM consolidations — skip & warn on failure
 */
export async function executeReport(report: CuratorReport): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		phaseA: { success: false },
		phaseB: { succeeded: [], failed: [] },
	}

	// Phase A: Atomic mechanical (fail-fast)
	try {
		const { proposeStale, proposeReactivate, proposeArchive } = report.autoTransitions

		// Batch state updates
		const stateChanges: { name: string; state: "active" | "stale" | "archived" }[] = [
			...proposeReactivate.map((name: string) => ({ name, state: STATE_ACTIVE })),
			...proposeStale.map((name: string) => ({ name, state: STATE_STALE })),
		]
		if (stateChanges.length > 0) {
			await setStateBatch(stateChanges)
		}

		// Archive each skill
		for (const name of proposeArchive) {
			await archiveSkill(name)
		}

		result.phaseA.success = true
	} catch (err) {
		result.phaseA.success = false
		result.phaseA.error = err instanceof Error ? err.message : String(err)
		throw err // Re-throw to abort
	}

	// Phase B: Best-effort LLM consolidations
	for (const proposal of report.consolidationProposals) {
		try {
			// Validate: all members still exist
			for (const member of proposal.members) {
				if (!(await skillExists(member))) {
					throw new Error(`Skill "${member}" not found — may have been archived`)
				}
			}

			await executeConsolidation(proposal)
			result.phaseB.succeeded.push(proposal.umbrella)
		} catch (err) {
			result.phaseB.failed.push({
				proposal: proposal.umbrella,
				error: err instanceof Error ? err.message : String(err),
			})
			// Continue to next — don't abort Phase B
		}
	}

	return result
}

async function executeConsolidation(proposal: {
	umbrella: string
	members: string[]
	rationale: string
}): Promise<void> {
	// This is a placeholder — actual consolidation logic will be implemented
	// when we wire up the skill_manage tool calls
	console.log(`Executing consolidation: ${proposal.umbrella} <- ${proposal.members.join(", ")}`)
}
