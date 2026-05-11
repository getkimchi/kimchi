import {
	CLAUDE_FAMILY_EXPLORE,
	CLAUDE_FAMILY_ORCHESTRATION,
	CLAUDE_FAMILY_PLAN,
	CLAUDE_FAMILY_REVIEW,
	CLAUDE_OPUS_47_EXPLORE,
	CLAUDE_OPUS_47_ORCHESTRATION,
	CLAUDE_OPUS_47_PLAN,
	CLAUDE_OPUS_47_REVIEW,
} from "./guidelines/claude-family.js"
import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./guidelines/default-orchestration-guidelines.js"
import {
	DEFAULT_BUILD_GUIDELINES,
	DEFAULT_EXPLORE_GUIDELINES,
	DEFAULT_PLAN_GUIDELINES,
	DEFAULT_REVIEW_GUIDELINES,
} from "./guidelines/default-phase-guidelines.js"
import {
	KIMI_FAMILY_BUILD,
	KIMI_FAMILY_ORCHESTRATION,
	KIMI_FAMILY_PLAN,
	KIMI_K25_BUILD,
	KIMI_K25_ORCHESTRATION,
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
	NEMOTRON_FAMILY_BUILD,
	NEMOTRON_FAMILY_EXPLORE,
	NEMOTRON_FAMILY_ORCHESTRATION,
} from "./guidelines/nemotron-family.js"
import type { ModelCapabilities } from "./types.js"

/**
 * Model descriptions are written as natural-language decision briefs, not
 * benchmark data sheets. While the orchestrator LLM could interpret raw
 * benchmark names and scores if we provided them with definitions, doing
 * so would significantly bloat the user prompt - each model would need
 * dozens of benchmark scores plus a glossary explaining what each one
 * measures. Instead, we pre-digest the benchmark evidence into concise
 * statements the orchestrator can act on directly: "strongest pure coding
 * model in the pool", "reliably formats tool calls correctly",
 * "near-perfect retrieval accuracy" etc.
 *
 * This map is a local capability knowledge-base keyed by model ID. It acts
 * as an enrichment layer on top of the dynamic model list fetched from the
 * API at startup. Models present in the API but absent here get a generic
 * descriptor and a startup warning. Models present here but absent from the
 * API are excluded from subagent routing (they cannot be called). The
 * intention is to iterate on these descriptions locally and promote them to
 * the API once the shape is stable.
 */

const KIMI_K26_DESCRIPTION = `\
Flagship Kimi model with vision support — the key model for complex planning decisions \
and deep research. Handles images, screenshots, and visual input with superior reasoning. \
When a hard problem needs architectural planning, strategic analysis, or methodical \
research, this is the model to delegate to. Best for complex multi-step tasks.`

const KIMI_K25_DESCRIPTION = `\
Kimi model with vision support — the workhorse for simpler execution tasks and \
exploration. Handles images, screenshots, and visual input. Best for straightforward \
coding tasks, quick exploration, and when vision input is needed but planning depth \
isn't critical. Reliable and efficient for well-scoped subtasks.`

const MINIMAX_M27_DESCRIPTION = `\
The strongest coding model in the pool. \
Best accuracy on multi-file bugs, complex refactors, and extended tool call chains. \
Best default choice for any well-scoped coding task.`

const NEMOTRON_3_SUPER_DESCRIPTION = `\
Cheapest and fastest. 1M token context window with near-perfect retrieval — \
can ingest entire large codebases in a single pass. \
Weakest at coding; not reliable for complex multi-file changes. \
Best for codebase exploration, research, and simple well-defined tasks.`

const CLAUDE_OPUS_47_DESCRIPTION = `\
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
				plan: concatGuidelines(DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN, KIMI_K26_PLAN),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				KIMI_FAMILY_ORCHESTRATION,
				KIMI_K26_ORCHESTRATION,
			),
		},
	],
	[
		"kimi-k2.5",
		{
			vision: true,
			strengths: ["research", "plan", "review"],
			tier: "heavy",
			description: KIMI_K25_DESCRIPTION,
			guidelines: {
				build: concatGuidelines(DEFAULT_BUILD_GUIDELINES, KIMI_FAMILY_BUILD, KIMI_K25_BUILD),
				plan: concatGuidelines(DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				KIMI_FAMILY_ORCHESTRATION,
				KIMI_K25_ORCHESTRATION,
			),
		},
	],
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
			strengths: ["build", "explore"],
			tier: "light",
			description: NEMOTRON_3_SUPER_DESCRIPTION,
			guidelines: {
				build: concatGuidelines(DEFAULT_BUILD_GUIDELINES, NEMOTRON_FAMILY_BUILD, NEMOTRON_3_SUPER_BUILD),
				explore: concatGuidelines(DEFAULT_EXPLORE_GUIDELINES, NEMOTRON_FAMILY_EXPLORE, NEMOTRON_3_SUPER_EXPLORE),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				NEMOTRON_FAMILY_ORCHESTRATION,
				NEMOTRON_3_SUPER_ORCHESTRATION,
			),
		},
	],
	[
		"claude-opus-4-7",
		{
			vision: true,
			strengths: ["explore", "research", "plan", "review"],
			tier: "heavy",
			description: CLAUDE_OPUS_47_DESCRIPTION,
			guidelines: {
				plan: concatGuidelines(DEFAULT_PLAN_GUIDELINES, CLAUDE_FAMILY_PLAN, CLAUDE_OPUS_47_PLAN),
				explore: concatGuidelines(DEFAULT_EXPLORE_GUIDELINES, CLAUDE_FAMILY_EXPLORE, CLAUDE_OPUS_47_EXPLORE),
				review: concatGuidelines(DEFAULT_REVIEW_GUIDELINES, CLAUDE_FAMILY_REVIEW, CLAUDE_OPUS_47_REVIEW),
			},
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				CLAUDE_FAMILY_ORCHESTRATION,
				CLAUDE_OPUS_47_ORCHESTRATION,
			),
		},
	],
	["glm-5-fp8", "ignored"],
	["minimax-m2.5", "ignored"],
	["claude-opus-4-6", "ignored"],
	["claude-sonnet-4-6", "ignored"],
	["claude-sonnet-4-5", "ignored"],
])
