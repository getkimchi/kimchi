import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js"

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
		// No caller override and persona declared a list. Default to the first
		// entry — note this is just a stable fallback, not a "lightest tier"
		// pick. The calling LLM is expected to pass `model` for any non-trivial
		// task; the runtime does not classify complexity.
		modelInput = agentConfig.models[0]
	}
	// else: undefined → inherit parent

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
