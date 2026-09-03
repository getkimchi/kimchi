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

import type { Skill } from "@earendil-works/pi-coding-agent"
import type { AgentConfig } from "../../agents/personas/types.js"
import type { PromptMode } from "../system-prompt.js"
import type { SuppressibleSection } from "../system-prompt-blocks.js"

/** A rendered system-prompt block as seen by a variant's rewriter. */
export interface VariantBlock {
	owner: string
	id: string
	content: string
}

export interface PromptVariant {
	/** Stable identifier, e.g. "spicy". Matches the env var value. */
	name: string

	/** Human-facing label shown next to the logo, falls back to name. */
	tagline?: string

	/**
	 * Force the assembly mode regardless of the caller's mode. Omit to keep
	 * the caller's mode (runtime-driven variants do not set this).
	 */
	forceMode?: PromptMode

	/** Replace the intro line. Receives the effective (post-forceMode) mode. */
	intro?: (mode: PromptMode) => string

	/** Replace the Documents section body. `null` omits the section entirely. */
	documents?: string | null

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
	 * Transform the skill list before it is formatted into the Skills section.
	 * Return a filtered/modified array, or `undefined` to leave the list
	 * unchanged. Runs before formatSkills, so it shapes the entire section.
	 */
	skillsTransform?: (skills: readonly Skill[]) => readonly Skill[] | undefined

	/**
	 * Rewrite a rendered system-prompt block (behaviours, todos, ...). Return a
	 * replacement string, `null` to drop the block, or `undefined` to keep it
	 * unchanged. Match on `owner`+`id`.
	 */
	rewriteBlock?: (block: VariantBlock, mode?: PromptMode) => string | null | undefined

	/** Extra sections to suppress, merged with block-declared suppressions. */
	suppress?: readonly SuppressibleSection[]

	/**
	 * Extra guidance prepended to the ferment planner supplement. Set it when
	 * the variant needs the planner to follow a specific lifecycle stance.
	 * Undefined leaves the supplement as-is.
	 */
	fermentSteer?: string

	/**
	 * When defined, the discipline-reminder extension periodically nudges the
	 * model with the given text. Presence (defined) enables the reminder;
	 * absent/undefined disables it entirely. everyPrompts controls cadence:
	 * fires on run 1 and every Nth run after that.
	 */
	disciplineReminder?: { text: string | ((mode: PromptMode) => string); everyPrompts: number }

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
