import { pickFromModelListByTier, recommendModel } from "../../orchestration/model-registry/recommend.js"
import type { ModelStrength } from "../../orchestration/model-registry/types.js"
import { getCurrentPhase } from "../../tags.js"
import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "../personas/types.js"

interface AgentInvocationParams {
	model?: string
	thinking?: string
	max_turns?: number
	run_in_background?: boolean
	inherit_context?: boolean
	isolated?: boolean
	isolation?: IsolationMode
}

export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
): {
	modelInput?: string
	modelFromParams: boolean
	thinking?: ThinkingLevel
	maxTurns?: number
	inheritContext: boolean
	runInBackground: boolean
	isolated: boolean
	isolation?: IsolationMode
} {
	let modelInput: string | undefined
	let modelFromParams = false

	if (params.model) {
		// Caller's explicit override — the LLM judges task complexity and picks
		// from the persona's `models` list (or any model id). This is the
		// preferred path for personas with multi-model arrays: the calling LLM
		// is in a far better position to assess complexity than any heuristic.
		modelInput = params.model
		modelFromParams = true
	} else if (agentConfig?.models?.length) {
		// No caller override and persona declared a list. Pick the entry whose
		// capability tier best matches the persona's preferTier (with the same
		// light→standard→heavy fallback as recommendModel). If preferTier is
		// not declared, defaults to "standard". The calling LLM is still
		// expected to pass `model` for non-trivial task complexity overrides;
		// this is the no-override default, not a complexity classifier.
		modelInput = pickFromModelListByTier(agentConfig.models, agentConfig.preferTier ?? "standard")
	} else if (agentConfig?.strengths?.length) {
		// Persona has strengths but no explicit models[] — let the orchestrator
		// auto-pick based on those strengths.
		const rec = recommendModel({
			strengths: agentConfig.strengths,
			preferTier: agentConfig.preferTier ?? "standard",
		})
		if (rec) {
			modelInput = `${rec.provider}/${rec.modelId}`
		}
		// else: fall through to inherit parent
	} else {
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
		// else: undefined → inherit parent
	}

	return {
		modelInput,
		modelFromParams,
		thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
		maxTurns: agentConfig?.maxTurns ?? params.max_turns,
		inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
		isolated: agentConfig?.isolated ?? params.isolated ?? false,
		isolation: agentConfig?.isolation ?? params.isolation,
	}
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
	return runInBackground ? defaultJoinMode : undefined
}
