/**
 * Intent-charter renderers.
 *
 * The charter (see src/ferment/types.ts:FermentCharter) is the ferment's
 * immutable objective anchor. It gets re-injected at two budgets:
 *
 *   - renderCharterCompact — hot paths that re-read it many times per run
 *     (continuation nudges, compaction instructions, stage handoffs). Hard
 *     budget: at most CHARTER_COMPACT_MAX_CHARS characters. Long-compaction
 *     sessions re-read the hot path dozens of times, and a long repeated
 *     preamble both costs tokens and trains the worker to skim it
 *     ("boilerplate blindness") — the anchor must stay short enough to remain
 *     salient on read #20.
 *   - renderCharterFull — decision points that evaluate against it (grader
 *     prompts, ship audit). Uncapped; these sites need the whole objective.
 *
 * Compact truncation is deterministic: drop the demo line first, then the wow
 * line, then truncate the intent itself with a stable marker. Tests pin the
 * budget so a renderer change cannot silently inflate every nudge.
 */

import type { FermentCharter } from "../../ferment/types.js"

/** Hard character budget for the compact render (hot-path injection sites). */
export const CHARTER_COMPACT_MAX_CHARS = 400

const TRUNCATION_MARKER = "… (truncated — full charter in ferment state)"

/** Collapse a free-text field to one line: trim + squash whitespace runs. */
function squash(text: string): string {
	return text.trim().replace(/\s+/g, " ")
}

function buildCompact(intent: string, wow?: string, demo?: string): string {
	const lines = ["Charter:", `  Intent: ${intent}`]
	if (wow) lines.push(`  Wow: ${wow}`)
	if (demo) lines.push(`  Demo: ${demo}`)
	return lines.join("\n")
}

/**
 * Render the charter for hot-path injection (nudges, compaction, handoff).
 * Never returns more than CHARTER_COMPACT_MAX_CHARS characters. Optional
 * fields that don't fit are dropped whole (demo first, then wow); the intent
 * is only truncated when it alone overflows the budget.
 */
export function renderCharterCompact(charter: FermentCharter): string {
	const intent = squash(charter.intent)
	const wow = charter.wowFactor ? squash(charter.wowFactor) : ""
	const demo = charter.demoScript ? squash(charter.demoScript) : ""

	let text = buildCompact(intent, wow || undefined, demo || undefined)
	if (text.length <= CHARTER_COMPACT_MAX_CHARS) return text

	text = buildCompact(intent, wow || undefined)
	if (text.length <= CHARTER_COMPACT_MAX_CHARS) return text

	text = buildCompact(intent)
	if (text.length <= CHARTER_COMPACT_MAX_CHARS) return text

	// The intent alone overflows: truncate it with a stable marker.
	const headerLength = "Charter:\n  Intent: ".length
	const budget = CHARTER_COMPACT_MAX_CHARS - headerLength - TRUNCATION_MARKER.length
	if (budget <= 0) return TRUNCATION_MARKER.slice(0, CHARTER_COMPACT_MAX_CHARS)
	return buildCompact(`${intent.slice(0, budget)}${TRUNCATION_MARKER}`)
}

/**
 * Render the charter for decision points (grader prompts, ship audit).
 * Uncapped and labeled; ends with the directive that ties the grade to the
 * original intent rather than the (possibly narrowed) plan.
 */
export function renderCharterFull(charter: FermentCharter): string {
	const lines = ["--- INTENT CHARTER ---"]
	lines.push(`Intent (the user's original request, verbatim): ${charter.intent.trim()}`)
	if (charter.wowFactor?.trim()) {
		lines.push(`Wow factor (what would delight, not merely satisfy): ${charter.wowFactor.trim()}`)
	}
	if (charter.confirmedScope?.trim()) {
		lines.push(`Confirmed scope (in / explicitly out): ${charter.confirmedScope.trim()}`)
	}
	if (charter.demoScript?.trim()) {
		lines.push(`Acceptance demo (beats the final walkthrough must show): ${charter.demoScript.trim()}`)
	}
	lines.push(
		"Grade against this charter — it records the user's original intent. The plan and criteria below are a refinement of it; where they read narrower than the intent, the intent wins unless the charter's confirmed scope says otherwise.",
	)
	return lines.join("\n")
}
