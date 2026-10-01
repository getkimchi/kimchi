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
	MINIMAX_FAMILY_PLAN,
	MINIMAX_FAMILY_RESEARCH,
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
High-capacity Kimi model with vision support — the key model for complex planning decisions, \
deep research, and correctness-critical tasks. Handles images, screenshots, and visual input. \
Best for: orchestration, architectural planning, plan verification involving concurrency \
or algorithmic design. \
WARNING — subagent reliability: This model is 2-3x slower than standard-tier models. \
As a build subagent it frequently times out before completing, even with 1.5x duration \
scaling. Prefer minimax-m2.7 for build subagents — it is faster and completes reliably \
within standard budgets. Use kimi-k2.6 as a build subagent ONLY as a retry after \
minimax has already failed on the same chunk.`

const KIMI_K27_DESCRIPTION = `\
Previous-generation Kimi flagship with vision support — strong at deep research, \
complex planning, and correctness-critical tasks. Handles images, screenshots, and visual input. \
Best for: deep research, architectural planning, plan verification involving concurrency or \
algorithmic design, multi-step coding tasks, and any work requiring image understanding.`

const KIMI_K3_DESCRIPTION = `\
Flagship Kimi model with vision support — the default for orchestration, deep research, \
complex planning, and correctness-critical review. Native multimodality (text, images, \
screenshots) with a 1M-token context window and frontier-level long-horizon coding and \
agentic performance. Best for: orchestration, architectural planning, plan verification \
involving concurrency or algorithmic design, multi-step coding tasks, correctness-critical \
review, and any work requiring image understanding.`

const GLM_53_DESCRIPTION = `\
Text-only flagship coding model from Z.ai with always-on reasoning and a 1M-token \
context window. Strong long-horizon agentic coding, and the leading open-weights model \
for vulnerability discovery and security review. Best for: architectural planning, plan \
and spec verification, judge and grading calls, security-critical code review, and \
long-document or whole-codebase analysis. Not suitable for: tasks requiring image or \
visual input (no vision support).`

const GLM_53_FLASH_DESCRIPTION = `\
Multimodal value-tier coding model from Z.ai — the first natively multimodal GLM-5 \
model (text, image, and video input) with a 1M-token context window. Near-flagship \
agentic coding performance at roughly one-tenth of flagship price. Best for: multi-file \
implementation, tool-driven build work, frontend and UI tasks involving screenshots or \
visual input, and volume work where cost per token matters. Prefer a heavy-tier model \
for concurrency-heavy, architectural, or security-critical work.`

const DEEPSEEK_V4_FLASH_0731_DESCRIPTION = `\
Fast and cost-effective model for codebase exploration and lightweight tasks — the \
official release of DeepSeek-V4-Flash with substantially enhanced agentic capabilities \
over the preview. High throughput with sub-second time to first token and a 1M-token \
context window — can ingest entire large codebases in a single pass. Best for: codebase \
exploration, reading code, tracing architecture, research, trivial re-verification \
(confirming tests pass after a fix), and context summarization. Note: very verbose at \
maximum reasoning effort — prefer lower effort levels for routine work.`

const MINIMAX_M3_DESCRIPTION = `\
Primary MiniMax model with vision support — heavy-tier builder and researcher. \
Handles images, screenshots, and visual input. \
Best for: multi-file implementation, concurrency-heavy code, deep research with citations, \
and plan verification involving complex logic.`

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

const DEEPSEEK_V4_FLASH_DESCRIPTION = `\
Fast and cost-effective model for codebase exploration and lightweight tasks. \
Best for: codebase exploration, reading code, tracing architecture, and trivial re-verification \
(confirming tests pass after a fix). \
Not suitable for: code review, building code, or any task requiring correctness judgment.`

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
function guidelinesMap(entries: Record<string, string[]>): Partial<Readonly<Record<Phase, string>>> | undefined {
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
			reasoning: true,
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
	[
		"kimi-k2.7",
		{
			vision: true,
			reasoning: true,
			tier: "heavy",
			description: KIMI_K27_DESCRIPTION,
			guidelines: guidelinesMap({
				research: [DEFAULT_RESEARCH_GUIDELINES, KIMI_FAMILY_RESEARCH],
				plan: [DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN],
				build: [DEFAULT_BUILD_GUIDELINES, KIMI_FAMILY_BUILD],
				review: [DEFAULT_REVIEW_GUIDELINES, KIMI_FAMILY_REVIEW],
			}),
			orchestrationGuidelines: optionalGuidelines(DEFAULT_ORCHESTRATION_GUIDELINES, KIMI_FAMILY_ORCHESTRATION),
		},
	],
	[
		"kimi-k3",
		{
			vision: true,
			reasoning: true,
			tier: "heavy",
			description: KIMI_K3_DESCRIPTION,
			guidelines: guidelinesMap({
				research: [DEFAULT_RESEARCH_GUIDELINES, KIMI_FAMILY_RESEARCH],
				plan: [DEFAULT_PLAN_GUIDELINES, KIMI_FAMILY_PLAN],
				build: [DEFAULT_BUILD_GUIDELINES, KIMI_FAMILY_BUILD],
				review: [DEFAULT_REVIEW_GUIDELINES, KIMI_FAMILY_REVIEW],
			}),
			orchestrationGuidelines: optionalGuidelines(DEFAULT_ORCHESTRATION_GUIDELINES, KIMI_FAMILY_ORCHESTRATION),
		},
	],
	["kimi-k2.5", "ignored"],
	[
		"minimax-m3",
		{
			vision: true,
			reasoning: true,
			tier: "heavy",
			description: MINIMAX_M3_DESCRIPTION,
			guidelines: guidelinesMap({
				research: [DEFAULT_RESEARCH_GUIDELINES, MINIMAX_FAMILY_RESEARCH],
				plan: [DEFAULT_PLAN_GUIDELINES, MINIMAX_FAMILY_PLAN],
				build: [DEFAULT_BUILD_GUIDELINES, MINIMAX_FAMILY_BUILD],
				review: [DEFAULT_REVIEW_GUIDELINES, MINIMAX_FAMILY_REVIEW],
			}),
			orchestrationGuidelines: optionalGuidelines(DEFAULT_ORCHESTRATION_GUIDELINES, MINIMAX_FAMILY_ORCHESTRATION),
		},
	],
	[
		"minimax-m2.7",
		{
			vision: false,
			reasoning: true,
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
		"glm-5.3",
		{
			vision: false,
			reasoning: true,
			tier: "heavy",
			description: GLM_53_DESCRIPTION,
			guidelines: guidelinesMap({
				research: [DEFAULT_RESEARCH_GUIDELINES],
				plan: [DEFAULT_PLAN_GUIDELINES],
				build: [DEFAULT_BUILD_GUIDELINES],
				review: [DEFAULT_REVIEW_GUIDELINES],
			}),
			orchestrationGuidelines: optionalGuidelines(
				DEFAULT_ORCHESTRATION_GUIDELINES,
				"When orchestrating (glm-5.3): no model-specific delegation overrides. Its vulnerability-discovery strength makes it a strong pick for delegated security-critical review; match its always-on reasoning effort to task complexity.",
			),
		},
	],
	[
		"glm-5.3-flash",
		{
			vision: true,
			reasoning: true,
			tier: "standard",
			description: GLM_53_FLASH_DESCRIPTION,
			guidelines: guidelinesMap({
				build: [DEFAULT_BUILD_GUIDELINES],
				review: [DEFAULT_REVIEW_GUIDELINES],
				explore: [DEFAULT_EXPLORE_GUIDELINES],
				research: [DEFAULT_RESEARCH_GUIDELINES],
			}),
			orchestrationGuidelines:
				"When orchestrating (glm-5.3-flash): no model-specific orchestration overrides — follow the default delegation rules.",
		},
	],
	[
		"nemotron-3-ultra-fp4",
		{
			vision: false,
			reasoning: false,
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
	[
		"deepseek-v4-flash",
		{
			vision: false,
			reasoning: false,
			tier: "light",
			description: DEEPSEEK_V4_FLASH_DESCRIPTION,
			guidelines: guidelinesMap({
				explore: [DEFAULT_EXPLORE_GUIDELINES],
				research: [DEFAULT_RESEARCH_GUIDELINES],
			}),
			orchestrationGuidelines:
				"When orchestrating (deepseek-v4-flash): No model-specific orchestration overrides — follow the default delegation rules.",
		},
	],
	[
		"deepseek-v4-flash-0731",
		{
			vision: false,
			reasoning: true,
			tier: "light",
			description: DEEPSEEK_V4_FLASH_0731_DESCRIPTION,
			guidelines: guidelinesMap({
				explore: [DEFAULT_EXPLORE_GUIDELINES],
				research: [DEFAULT_RESEARCH_GUIDELINES],
			}),
			orchestrationGuidelines:
				"When orchestrating (deepseek-v4-flash-0731): no model-specific orchestration overrides — follow the default delegation rules. Prefer lower reasoning-effort levels for routine exploration; max effort is very verbose.",
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
