import { pickFromModelListByTier, recommendModel } from "../../orchestration/model-registry/recommend.js"
import type { ModelStrength } from "../../orchestration/model-registry/types.js"
import { getCurrentPhase } from "../../tags.js"
import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "../personas/types.js"

interface AgentInvocationParams {
	model?: string
	thinking?: string
	max_turns?: number
	token_budget?: number
	tokenBudget?: number
	max_duration?: number
	run_in_background?: boolean
	inherit_context?: boolean
	isolated?: boolean
	isolation?: IsolationMode
}

/**
 * Resolves agent invocation config by merging caller params with persona defaults.
 *
 * Precedence by field:
 * - model: caller override first, unless the persona locks model selection.
 * - tokenBudget: caller override first, then persona default.
 * - thinking, maxTurns, isolation, inheritContext, runInBackground: persona
 *   policy first, then caller value.
 */
export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
): {
	modelInput?: string
	modelFromParams: boolean
	thinking?: ThinkingLevel
	maxTurns?: number
	tokenBudget?: number
	maxDuration?: number
	inheritContext: boolean
	runInBackground: boolean
	isolated: boolean
	isolation?: IsolationMode
} {
	let modelInput: string | undefined
	let modelFromParams = false

	const resolveProfileModel = () => {
		if (agentConfig?.models?.length) {
			// Persona declared a list. Pick the entry whose capability tier best
			// matches the persona's preferTier.
			return pickFromModelListByTier(agentConfig.models, agentConfig.preferTier ?? "standard")
		}
		if (agentConfig?.strengths?.length) {
			// Persona has strengths but no explicit models[] — let the orchestrator
			// auto-pick based on those strengths.
			const rec = recommendModel({
				strengths: agentConfig.strengths,
				preferTier: agentConfig.preferTier ?? "standard",
			})
			return rec ? `${rec.provider}/${rec.modelId}` : undefined
		}
		return undefined
	}

	if (agentConfig?.modelLocked) {
		modelInput = resolveProfileModel()
	} else if (params.model) {
		// Caller's explicit override — the LLM judges task complexity and picks
		// from the persona's `models` list (or any model id). This is the
		// preferred path for personas with multi-model arrays: the calling LLM
		// is in a far better position to assess complexity than any heuristic.
		modelInput = params.model
		modelFromParams = true
	} else {
		modelInput = resolveProfileModel()
	}

	if (!modelInput && !agentConfig?.models?.length && !agentConfig?.strengths?.length) {
		// Phase-aware fallback: if current phase is a known strength, recommend
		// a model for that phase.
		const phase = getCurrentPhase()
		const VALID_STRENGTHS: ReadonlySet<string> = new Set<ModelStrength>([
			"build",
			"explore",
			"plan",
			"review",
			"research",
		])
		if (phase && VALID_STRENGTHS.has(phase)) {
			const rec = recommendModel({
				strengths: [phase as ModelStrength],
				preferTier: "standard",
			})
			if (rec) {
				modelInput = `${rec.provider}/${rec.modelId}`
			}
		}
	}

	return {
		modelInput,
		modelFromParams,
		thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
		maxTurns: agentConfig?.maxTurns ?? params.max_turns,
		tokenBudget: params.token_budget ?? params.tokenBudget ?? agentConfig?.tokenBudget,
		maxDuration: params.max_duration ?? agentConfig?.maxDuration,
		inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
		isolated: agentConfig?.isolated ?? params.isolated ?? false,
		isolation: agentConfig?.isolation ?? params.isolation,
	}
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
	return runInBackground ? defaultJoinMode : undefined
}
