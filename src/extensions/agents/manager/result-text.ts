/**
 * result-text.ts — Composition of the Agent tool's final result text.
 *
 * Shared by the local completion chain in agent-manager.ts; kept in its own
 * module so test doubles that stub agent-runner.js don't have to provide it.
 */

import type { SkillTriggerHit } from "../../skills-manager/skill-triggers.js"

export interface RunResultTextParts {
	responseText: string
	planPath?: string
	autoLoadedSkills?: SkillTriggerHit[]
	droppedToolNames?: string[]
}

/**
 * Compose the Agent tool's final result text: the worker's response, the
 * saved-plan pointer when a plan was submitted, the brief-triggered skill
 * preloads, and the dropped-tool warning when requested tools could not be
 * registered. Exported so the composition is unit-testable.
 */
export function formatRunResultText({
	responseText,
	planPath,
	autoLoadedSkills,
	droppedToolNames,
}: RunResultTextParts): string {
	// Surface brief-triggered skill preloads in the tool result so the
	// orchestrator and the user transcript (both surfaces) see what was
	// injected into the child's context.
	const autoLoadNote = autoLoadedSkills?.length
		? `\n\nSkills auto-loaded from task brief: ${autoLoadedSkills.map((s) => `${s.name} (${s.matched})`).join(", ")}`
		: ""
	// Surface requested-but-unregistered tool drops: otherwise a persona or
	// custom agent `tools:` entry silently produces nothing (this bug class
	// hid web_search/web_fetch from the built-in Researcher for months).
	const droppedNote = droppedToolNames?.length
		? `\n\nWarning: requested tool(s) were dropped because they are not registered in the subagent session: ${droppedToolNames.join(", ")}. Check the agent's tools list or enable the extension that provides them.`
		: ""
	const base = planPath ? `${responseText}\n\nPlan saved to: ${planPath}` : responseText
	return `${base}${autoLoadNote}${droppedNote}`
}
