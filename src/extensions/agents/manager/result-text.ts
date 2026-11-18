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
 * Bound tool names (sourced from user-authored frontmatter) before
 * interpolation into LLM-visible text: anything outside the conventional
 * tool-name charset becomes '?', capping novel-prompt-injection surface.
 */
export function sanitizeToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_.-]/g, "?")
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
	const planNote = planPath ? `\n\nPlan saved to: ${planPath}` : ""
	// Surface requested-but-not-active tools: otherwise a persona or custom
	// agent `tools:` entry silently produces nothing, whatever the cause
	// (unregistered, allowlist-filtered, resource-gated, runner-excluded).
	// (This class of bug hid web_search/web_fetch from the Researcher persona
	// for months — see docs/agents.md.)
	const droppedNote = droppedToolNames?.length
		? `\n\nWarning: requested tool(s) are not active in the subagent session: ${droppedToolNames.map(sanitizeToolName).join(", ")}. Check the agent's tools list, enable the extension that provides them, or check the org resource toggle (/resources) that gates that extension.`
		: ""
	return `${responseText}${planNote}${autoLoadNote}${droppedNote}`
}
