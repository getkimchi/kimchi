/**
 * Spicy variant descriptor.
 *
 * This file shows at a glance every knob the spicy variant overrides.
 * The prose (text constants and helpers) lives in ./spicy-prompts.ts.
 */

import type { PromptMode } from "../system-prompt.js"
import {
	appendDisciplineBlock,
	disciplineNudgeFor,
	guidelinesFor,
	ORCHESTRATOR_INTRO,
	SINGLE_INTRO,
	SPICY_COMMIT_ATTRIBUTION,
	SPICY_FERMENT_STEER,
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
	fermentSteer: SPICY_FERMENT_STEER,
	disciplineReminder: {
		text: disciplineNudgeFor,
		everyPrompts: 4,
	},
	transformAgents: appendDisciplineBlock,
}
