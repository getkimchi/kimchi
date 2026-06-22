import { DEFAULT_ORCHESTRATION_GUIDELINES } from "./guidelines/default-orchestration-guidelines.js"
import {
	DEFAULT_BUILD_GUIDELINES,
	DEFAULT_EXPLORE_GUIDELINES,
	DEFAULT_PLAN_GUIDELINES,
	DEFAULT_RESEARCH_GUIDELINES,
	DEFAULT_REVIEW_GUIDELINES,
} from "./guidelines/default-phase-guidelines.js"
import {
	KIMI_FAMILY_BUILD,
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
	NEMOTRON_3_ULTRA_BUILD,
	NEMOTRON_3_ULTRA_EXPLORE,
	NEMOTRON_3_ULTRA_ORCHESTRATION,
	NEMOTRON_3_ULTRA_RESEARCH,
	NEMOTRON_FAMILY_BUILD,
	NEMOTRON_FAMILY_EXPLORE,
	NEMOTRON_FAMILY_ORCHESTRATION,
	NEMOTRON_FAMILY_RESEARCH,
} from "./guidelines/nemotron-family.js"
import type { ModelCapabilities, Phase } from "./types.js"

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
Flagship Kimi model with vision support — the key model for complex planning decisions, \
deep research, and correctness-critical tasks. Handles images, screenshots, and visual input. \
Best for: orchestration, architectural planning, plan verification involving concurrency \
or algorithmic design. \
WARNING — subagent reliability: This model is 2-3x slower than standard-tier models. \
As a build subagent it frequently times out before completing, even with 1.5x duration \
scaling. Prefer minimax-m2.7 for build subagents — it is faster and completes reliably \
within standard budgets. Use kimi-k2.6 as a build subagent ONLY as a retry after \
minimax has already failed on the same chunk.`

const MINIMAX_M27_DESCRIPTION = `\
The strongest coding model in the pool. \
Best accuracy on multi-file bugs, complex refactors, and extended tool call chains. \
Best for: well-scoped coding tasks (CRUD, parsers, handlers, CLI wiring, straightforward tests), \
and mechanical code review of straightforward code. \
Not reliable for algorithm-correctness tasks (graph algorithms, topological sort, complex data \
structure invariants) — use a heavy-tier model for those.`

const NEMOTRON_3_ULTRA_DESCRIPTION = `\
Cheapest and fastest. 1M token context window with near-perfect retrieval — \
can ingest entire large codebases in a single pass. \
Best for: codebase exploration, research, and trivial re-verification (confirming tests pass \
after a fix). \
Not suitable for: code review, building code, or any task requiring correctness judgment.`

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

/** Build a guidelines record, omitting entries where all layers are empty. */
function guidelinesMap(
	entries: Partial<Record<Phase, string[]>>,
): Partial<Readonly<Record<Phase, string>>> | undefined {
	const result: Record<string, string> = {}
	for (const [phase, layers] of Object.entries(entries)) {
		const value = concatGuidelines(...layers)
		if (value) result[phase] = value
	}
	return Object.keys(result).length > 0 ? result : undefined
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
			tier: "heavy",
			description: KIMI_K26_DESCRIPTION,
			guidelines: guidelinesMap({
				research: [DEFAULT_RESEARCH_GUIDELINES, KIMI_FAMILY_RESEARCH],
				plan: [DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN, KIMI_K26_PLAN],
				build: [DEFAULT_BUILD_GUIDELINES, KIMI_FAMILY_BUILD],
				review: [DEFAULT_REVIEW_GUIDELINES, KIMI_FAMILY_REVIEW],
			}),
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
			tier: "standard",
			description: MINIMAX_M27_DESCRIPTION,
			guidelines: guidelinesMap({
				build: [DEFAULT_BUILD_GUIDELINES, MINIMAX_FAMILY_BUILD, MINIMAX_M27_BUILD],
				review: [DEFAULT_REVIEW_GUIDELINES, MINIMAX_FAMILY_REVIEW, MINIMAX_M27_REVIEW],
			}),
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				MINIMAX_FAMILY_ORCHESTRATION,
				MINIMAX_M27_ORCHESTRATION,
			),
		},
	],
	[
		"nemotron-3-ultra-fp4",
		{
			vision: false,
			tier: "light",
			description: NEMOTRON_3_ULTRA_DESCRIPTION,
			guidelines: guidelinesMap({
				build: [DEFAULT_BUILD_GUIDELINES, NEMOTRON_FAMILY_BUILD, NEMOTRON_3_ULTRA_BUILD],
				research: [DEFAULT_RESEARCH_GUIDELINES, NEMOTRON_FAMILY_RESEARCH, NEMOTRON_3_ULTRA_RESEARCH],
				explore: [DEFAULT_EXPLORE_GUIDELINES, NEMOTRON_FAMILY_EXPLORE, NEMOTRON_3_ULTRA_EXPLORE],
			}),
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				NEMOTRON_FAMILY_ORCHESTRATION,
				NEMOTRON_3_ULTRA_ORCHESTRATION,
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
