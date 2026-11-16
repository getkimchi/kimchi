/**
 * result-text.ts — Composition of the Agent tool's final result text.
 *
 * Shared by the local completion chain in agent-manager.ts; kept in its own
 * module so test doubles that stub agent-runner.js don't have to provide it.
 */

import type { SkillTriggerHit } from "../../skills-manager/skill-triggers.js"

/**
 * Compose the Agent tool's final result text: the worker's response, the
 * saved-plan pointer when a plan was submitted, and the brief-triggered
 * skill preloads. Exported so the composition is unit-testable.
 */
export function formatRunResultText(
	responseText: string,
	planPath: string | undefined,
	autoLoadedSkills: SkillTriggerHit[] | undefined,
): string {
	// Surface brief-triggered skill preloads in the tool result so the
	// orchestrator and the user transcript (both surfaces) see what was
	// injected into the child's context.
	const autoLoadNote = autoLoadedSkills?.length
		? `\n\nSkills auto-loaded from task brief: ${autoLoadedSkills.map((s) => `${s.name} (${s.matched})`).join(", ")}`
		: ""
	const planNote = planPath
		? `\n\nPlan saved to: ${planPath}\nOnce approved, apply small plan updates with the edit tool at ${planPath} as work reveals changes.`
		: ""
	return `${responseText}${planNote}${autoLoadNote}`
}
