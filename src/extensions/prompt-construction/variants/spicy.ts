/**
 * Spicy variant descriptor.
 *
 * This file shows at a glance every knob the spicy variant overrides.
 * The prose (text constants and helpers) lives in ./spicy-prompts.ts.
 */

import type { PromptMode } from "../system-prompt.js"
import {
	appendDisciplineBlock,
	fermentSteerFor,
	guidelinesFor,
	ORCHESTRATOR_INTRO,
	rulesBlockFor,
	SINGLE_INTRO,
	SPICY_COMMIT_ATTRIBUTION,
	SPICY_SINGLE_MODE_DELEGATION,
} from "./spicy-prompts.js"
import type { PromptVariant } from "./types.js"

// ---------------------------------------------------------------------------
// Stable config constants
// ---------------------------------------------------------------------------

export const SPICY_NAME = "spicy"

// ---------------------------------------------------------------------------
// Descriptor: the full set of knobs spicy overrides
// ---------------------------------------------------------------------------

export const SPICY: PromptVariant = {
	name: SPICY_NAME,
	tagline: "spicy architect",
	intro: (mode: PromptMode) => (mode === "orchestrator" ? ORCHESTRATOR_INTRO : SINGLE_INTRO),
	guidelines: guidelinesFor,
	factualAccuracy: null,
	commitAttribution: SPICY_COMMIT_ATTRIBUTION,
	singleModeDelegation: SPICY_SINGLE_MODE_DELEGATION,
	fermentSteer: fermentSteerFor,
	rulesReminder: {
		text: rulesBlockFor,
		// Five minutes: long enough that a burst of short prompts does not repeat
		// the rules, short enough that they stay in recent context on a long
		// session where earlier turns have scrolled far back.
		intervalMs: 5 * 60 * 1000,
	},
	transformAgents: appendDisciplineBlock,
}
