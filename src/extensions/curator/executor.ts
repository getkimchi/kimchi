import { SkillManager, archiveSkill } from "../skills-manager/skill-manager.js"
import { STATE_ACTIVE, STATE_STALE, UsageTracker, setStateBatch } from "../skills-manager/usage.js"
import { rollback, snapshotBeforeCurator } from "./backup.js"
import { readMemberContents, readSkillContent, synthesizeUmbrellaContent } from "./helpers.js"
import type { ConsolidationProposal, CuratorReport, ExecutionResult } from "./types.js"

/**
 * Execute a curator report in three phases:
 * - Phase A: Atomic mechanical operations (reactivate, stale, archive) — fail-fast
 * - Phase B: Best-effort LLM consolidations — rollback on failure
 * - Phase C: Backup (always runs first, not gated on execute flag)
 */
export async function executeReport(
	report: CuratorReport,
	skillsDir: string,
	initialBackupDir?: string, // N2 fix: accept backupDir to avoid double snapshot
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		phaseA: { success: false },
		phaseB: { succeeded: [], failed: [] },
	}

	const manager = new SkillManager(skillsDir)
	const tracker = new UsageTracker(skillsDir)

	// Phase C: Backup ALWAYS runs first (not gated on execute flag)
	// N2 fix: use provided backupDir if available, otherwise create
	let backupDir: string | undefined = initialBackupDir
	if (!backupDir) {
		try {
			backupDir = await snapshotBeforeCurator(skillsDir)
		} catch (err) {
			console.error("Backup failed, continuing without snapshot:", err)
		}
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

	// Phase B: Best-effort LLM consolidations with rollback on failure
	for (const proposal of report.consolidationProposals) {
		try {
			// Validate: all members still exist
			for (const member of proposal.members) {
				if (!(await manager.exists(member))) {
					throw new Error(`Skill "${member}" not found — may have been archived`)
				}
			}

			await executeConsolidation(proposal, manager, tracker, skillsDir)
			result.phaseB.succeeded.push(proposal.umbrella)
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err)
			result.phaseB.failed.push({ proposal: proposal.umbrella, error })

			// Rollback on Phase B failure (G6 fix)
			if (backupDir) {
				try {
					await rollback(backupDir, skillsDir)
				} catch (rollbackErr) {
					console.error("Rollback failed:", rollbackErr)
				}
			}
		}
	}

	return result
}

async function executeConsolidation(
	proposal: ConsolidationProposal,
	manager: SkillManager,
	tracker: UsageTracker,
	skillsDir: string,
): Promise<void> {
	switch (proposal.strategy) {
		case "create_new":
			await executeCreateNew(proposal, manager, tracker, skillsDir)
			break
		case "merge_into_existing":
			await executeMergeIntoExisting(proposal, manager, tracker, skillsDir)
			break
		case "demote_to_references":
			await executeDemoteToReferences(proposal, manager, tracker, skillsDir)
			break
	}
}

async function executeCreateNew(
	proposal: ConsolidationProposal,
	manager: SkillManager,
	tracker: UsageTracker,
	skillsDir: string,
): Promise<void> {
	const memberContents = await readMemberContents(proposal.members, skillsDir)
	const umbrellaContent = await synthesizeUmbrellaContent(memberContents, proposal)

	const r1 = await manager.create(proposal.umbrella, umbrellaContent)
	if (!r1.success) throw new Error(`Failed to create umbrella: ${r1.error}`)

	for (const member of proposal.members) {
		const r2 = await manager.delete(member, proposal.umbrella)
		if (!r2.success) throw new Error(`Failed to archive ${member}: ${r2.error}`)
		await tracker.archive(member, proposal.umbrella) // Sets absorbed_into at delete time
	}
}

async function executeMergeIntoExisting(
	proposal: ConsolidationProposal,
	manager: SkillManager,
	tracker: UsageTracker,
	skillsDir: string,
): Promise<void> {
	// First member stays, others get merged into it
	for (const member of proposal.members.slice(1)) {
		const content = await readSkillContent(member, skillsDir)
		const r = await manager.patch(proposal.umbrella, "<!-- NEW SECTION -->", content)
		if (!r.success) throw new Error(`Failed to patch ${proposal.umbrella} with ${member}`)

		const r2 = await manager.delete(member, proposal.umbrella)
		if (!r2.success) throw new Error(`Failed to archive ${member}`)
		await tracker.archive(member, proposal.umbrella)
	}
}

async function executeDemoteToReferences(
	proposal: ConsolidationProposal,
	manager: SkillManager,
	tracker: UsageTracker,
	skillsDir: string,
): Promise<void> {
	// Create umbrella first if it doesn't exist (G7 fix)
	const umbrellaExists = await manager.exists(proposal.umbrella)
	if (!umbrellaExists) {
		const memberContents = await readMemberContents(proposal.members, skillsDir)
		const content = await synthesizeUmbrellaContent(memberContents, proposal)
		await manager.create(proposal.umbrella, content)
	}

	// Demote member content to references/ under umbrella
	for (const member of proposal.members) {
		const content = await readSkillContent(member, skillsDir)
		const r = await manager.writeFile(proposal.umbrella, `references/${member}.md`, content)
		if (!r.success) throw new Error(`Failed to write reference for ${member}`)

		const r2 = await manager.delete(member, proposal.umbrella)
		if (!r2.success) throw new Error(`Failed to archive ${member}`)
		await tracker.archive(member, proposal.umbrella)
	}
}
