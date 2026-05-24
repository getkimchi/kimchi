import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./guidelines/default-orchestration-guidelines.js"
import {
	DEFAULT_BUILD_GUIDELINES,
	DEFAULT_EXPLORE_GUIDELINES,
	DEFAULT_PLAN_GUIDELINES,
	DEFAULT_RESEARCH_GUIDELINES,
	DEFAULT_REVIEW_GUIDELINES,
} from "./guidelines/default-phase-guidelines.js"
import {
	KIMI_FAMILY_ORCHESTRATION,
	KIMI_FAMILY_PLAN,
	KIMI_FAMILY_RESEARCH,
	KIMI_FAMILY_REVIEW,
	KIMI_K26_ORCHESTRATION,
	KIMI_K26_PLAN,
} from "./guidelines/kimi-family.js"
import {
	MINIMAX_FAMILY_BUILD,
	MINIMAX_FAMILY_ORCHESTRATION,
	MINIMAX_FAMILY_REVIEW,
	MINIMAX_M27_BUILD,
	MINIMAX_M27_ORCHESTRATION,
	MINIMAX_M27_REVIEW,
} from "./guidelines/minimax-family.js"
import {
	NEMOTRON_3_SUPER_BUILD,
	NEMOTRON_3_SUPER_EXPLORE,
	NEMOTRON_3_SUPER_ORCHESTRATION,
	NEMOTRON_3_SUPER_RESEARCH,
	NEMOTRON_FAMILY_BUILD,
	NEMOTRON_FAMILY_EXPLORE,
	NEMOTRON_FAMILY_ORCHESTRATION,
	NEMOTRON_FAMILY_RESEARCH,
} from "./guidelines/nemotron-family.js"
import type { ModelCapabilities } from "./types.js"

/**
 * This map is a local capability knowledge-base keyed by model ID. It acts
 * as an enrichment layer on top of the dynamic model list fetched from the
 * API at startup. Models present in the API but absent here get a generic
 * descriptor and a startup warning. Models present here but absent from the
 * API are excluded from subagent routing (they cannot be called). The
 * intention is to iterate on these capabilities locally and promote them to
 * the API once the shape is stable.
 */

const KIMI_K26_DESCRIPTION = `\
Flagship Kimi model with vision support — the key model for complex planning decisions \
and deep research. Handles images, screenshots, and visual input with superior reasoning. \
When a hard problem needs architectural planning, strategic analysis, or methodical \
research, this is the model to delegate to. Best for complex multi-step tasks.`

const MINIMAX_M27_DESCRIPTION = `\
The strongest coding model in the pool. \
Best accuracy on multi-file bugs, complex refactors, and extended tool call chains. \
Best default choice for any well-scoped coding task.`

const NEMOTRON_3_SUPER_DESCRIPTION = `\
Cheapest and fastest. 1M token context window with near-perfect retrieval — \
can ingest entire large codebases in a single pass. \
Weakest at coding; not reliable for complex multi-file changes. \
Best for codebase exploration, research, and simple well-defined tasks.`

const CLAUDE_OPUS_46_DESCRIPTION = `\
Anthropic's flagship Claude model. Dominates at architectural planning and complex task \
decomposition — when a hard problem needs a superior plan, this is the model to delegate to. \
Also excels at deep reasoning, research, and exploration across large codebases. Best for \
complex multi-step tasks requiring careful analysis and methodical planning.`

/** Filter out empty layers and join with double newlines. */
function concatGuidelines(...layers: string[]): string {
	return layers.filter(Boolean).join("\n\n")
}

/** Compose guideline layers; returns undefined when all layers are empty
 *  so the resolver falls back to the default constant. */
function optionalGuidelines(...layers: string[]): string | undefined {
	return concatGuidelines(...layers) || undefined
}

// TODO: these capabilities could be returned by our models metadata API.
/**
 * Capability knowledge-base keyed by model ID. Used to enrich the dynamic
 * model list from the API with orchestration metadata (tier, strengths,
 * vision, description). Models not present here get a generic descriptor
 * and a startup warning.
 *
 * Set the value to "ignored" to suppress the startup warning for a model
 * without adding routing support for it.
 */
export const MODEL_CAPABILITIES: ReadonlyMap<string, ModelCapabilities | "ignored"> = new Map<
	string,
	ModelCapabilities | "ignored"
>([
	[
		"kimi-k2.6",
		{
			vision: true,
			strengths: ["research", "plan", "review"],
			tier: "heavy",
			description: KIMI_K26_DESCRIPTION,
			guidelines: {
				research: concatGuidelines(DEFAULT_RESEARCH_GUIDELINES, KIMI_FAMILY_RESEARCH),
				plan: concatGuidelines(DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN, KIMI_K26_PLAN),
				review: concatGuidelines(DEFAULT_REVIEW_GUIDELINES, KIMI_FAMILY_REVIEW),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				KIMI_FAMILY_ORCHESTRATION,
				KIMI_K26_ORCHESTRATION,
			),
		},
	],
	["kimi-k2.5", "ignored"],
	[
		"minimax-m2.7",
		{
			vision: false,
			strengths: ["build", "review"],
			tier: "standard",
			description: MINIMAX_M27_DESCRIPTION,
			guidelines: {
				build: concatGuidelines(DEFAULT_BUILD_GUIDELINES, MINIMAX_FAMILY_BUILD, MINIMAX_M27_BUILD),
				review: concatGuidelines(DEFAULT_REVIEW_GUIDELINES, MINIMAX_FAMILY_REVIEW, MINIMAX_M27_REVIEW),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				MINIMAX_FAMILY_ORCHESTRATION,
				MINIMAX_M27_ORCHESTRATION,
			),
		},
	],
	[
		"nemotron-3-super-fp4",
		{
			vision: false,
			strengths: ["explore", "research"],
			tier: "light",
			description: NEMOTRON_3_SUPER_DESCRIPTION,
			guidelines: {
				build: concatGuidelines(DEFAULT_BUILD_GUIDELINES, NEMOTRON_FAMILY_BUILD, NEMOTRON_3_SUPER_BUILD),
				research: concatGuidelines(DEFAULT_RESEARCH_GUIDELINES, NEMOTRON_FAMILY_RESEARCH, NEMOTRON_3_SUPER_RESEARCH),
				explore: concatGuidelines(DEFAULT_EXPLORE_GUIDELINES, NEMOTRON_FAMILY_EXPLORE, NEMOTRON_3_SUPER_EXPLORE),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				NEMOTRON_FAMILY_ORCHESTRATION,
				NEMOTRON_3_SUPER_ORCHESTRATION,
			),
		},
	],
	// Proprietary (Anthropic) models — excluded from OSS subagent routing.
	// Capability metadata is preserved in claude-family.ts for reference.
	["claude-opus-4-6", "ignored"],
	["glm-5-fp8", "ignored"],
	["minimax-m2.5", "ignored"],
	["claude-opus-4-6-20250514", "ignored"],
	["claude-sonnet-4-6", "ignored"],
	["claude-sonnet-4-5", "ignored"],
])
