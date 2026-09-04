/**
 * Prompt variants: opt-in alternative system-prompt wordings selected via the
 * `KIMCHI_PROMPT_VARIANT` environment variable. The default variant is a no-op
 * (every field undefined) so the assembled prompt is byte-for-byte identical to
 * the original when no variant is active.
 *
 * A variant describes OVERRIDES. Anything left undefined falls through to the
 * stock text in system-prompt.ts. This keeps the default path untouched and lets
 * a variant change only what it cares about.
 */

import type { AgentConfig } from "../../agents/personas/types.js"
import type { PromptMode } from "../system-prompt.js"

export interface PromptVariant {
	/** Stable identifier, e.g. "spicy". Matches the env var value. */
	name: string

	/** Human-facing label shown next to the logo, falls back to name. */
	tagline?: string

	/** Replace the intro line. Receives the assembly mode. */
	intro?: (mode: PromptMode) => string

	/** Replace the Guidelines section body. */
	guidelines?: string | ((mode: PromptMode) => string)

	/** Replace the Factual Accuracy section body. `null` omits the section. */
	factualAccuracy?: string | null

	/**
	 * Replace the commit-trailer bullet (`CORE_GUIDELINES_COMMIT_TRAILER_LINE`)
	 * with the variant's own commit-attribution rule. Applied wherever the core
	 * guidelines are emitted, including the subagent personas that pull them in,
	 * so the main thread and its subagents follow one attribution rule.
	 */
	commitAttribution?: string

	/**
	 * Replace the delegation stance inside the Single-Model Mode section (the
	 * stock `SINGLE_MODE_DELEGATION_TEXT`). Set it when the variant's own
	 * guidance is built on delegating work to subagents, so the two do not
	 * contradict each other. Only that text is replaced; the rest of the section,
	 * including which model a spawned subagent runs on, is untouched.
	 */
	singleModeDelegation?: string

	/**
	 * Extra guidance prepended to the ferment planner supplement. Set it when
	 * the variant needs the planner to follow a specific lifecycle stance.
	 * Undefined leaves the supplement as-is. Receives the planner's prompt mode,
	 * because the supplement's own execution stance differs between the two:
	 * an orchestrator planner delegates every step, a single-model planner
	 * executes them directly.
	 */
	fermentSteer?: string | ((mode: PromptMode) => string)

	/**
	 * When defined, the rules-reminder extension appends the variant's working
	 * rules to the user's turn. Presence (defined) enables the reminder;
	 * absent/undefined disables it entirely. `text` returns the block for the
	 * session's prompt mode, or undefined when that mode gets no rules; it also
	 * receives whether a ferment is in progress, because a ferment's planner
	 * rules own the execution stance while it runs. `intervalMs` throttles
	 * repeats within a session: the first prompt always gets the block, later
	 * prompts only once the interval has passed. 0 sends it on every prompt.
	 */
	rulesReminder?: { text: (mode: PromptMode, fermentActive: boolean) => string | undefined; intervalMs: number }

	/**
	 * Transform built-in default agent personas before they are registered for
	 * the session. Receives the list of default `AgentConfig` objects and must
	 * return a (possibly modified) list of the same shape. Only called on the
	 * built-in defaults -- user/project custom agents are never passed here.
	 *
	 * Return the input unchanged to be a no-op. Leaving this field `undefined`
	 * (as the default variant does) skips the transform entirely, guaranteeing
	 * the default path is byte-identical to today.
	 */
	transformAgents?: (agents: readonly AgentConfig[]) => readonly AgentConfig[]
}
