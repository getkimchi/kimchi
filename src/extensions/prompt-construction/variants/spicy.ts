/**
 * Spicy variant descriptor.
 *
 * This file shows at a glance every knob the spicy variant overrides.
 * The prose (text constants and helpers) lives in ./spicy-prompts.ts.
 *
 * Because every symbol the descriptor references is resolved at import time
 * (before the module body runs), there is no temporal-dead-zone problem and
 * SPICY sits right at the top after imports.
 */

import type { PromptMode } from "../system-prompt.js"
import {
	appendDisciplineBlock,
	blockRewriter,
	disciplineNudgeFor,
	guidelinesFor,
	ORCHESTRATOR_INTRO,
	SINGLE_INTRO,
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
	rewriteBlock: blockRewriter,
	suppressBashToolGuard: true,
	suppressExplorationGuard: true,
	disciplineReminder: {
		text: disciplineNudgeFor,
		everyPrompts: 4,
	},
	transformAgents: appendDisciplineBlock,
}

// ---------------------------------------------------------------------------
// Re-exports so existing import paths keep resolving
// ---------------------------------------------------------------------------

export {
	AGENT_DISCIPLINE_BLOCK,
	AGENT_ROLE_TUNING,
	appendDisciplineBlock,
	blockRewriter,
	COORDINATOR_DELEGATION_BLOCK,
	DISCIPLINE_NUDGE_CORE,
	DISCIPLINE_NUDGE_DELEGATION,
	DISCIPLINE_NUDGE_PREFIX,
	DISCIPLINE_NUDGE_TEXT,
	disciplineNudgeFor,
	guidelinesFor,
	OPINIONATED_BLOCK,
	OPINIONATED_BLOCK_ORCHESTRATOR,
	ORCHESTRATOR_INTRO,
	RULES_BLOCK,
	RULES_BLOCK_ORCHESTRATOR,
	SINGLE_INTRO,
	SPICY_COMMIT_ATTRIBUTION,
	TODOS_BLOCK,
} from "./spicy-prompts.js"
