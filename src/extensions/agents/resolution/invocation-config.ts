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
 * Model selection is pass-through: `params.model` is used as-is when
 * provided, otherwise modelInput is undefined and the caller falls back
 * to the parent model.  The orchestrator LLM is responsible for picking
 * the right model from "Your Team" based on task complexity.
 *
 * Other fields:
 * - tokenBudget: caller override first, then persona default.
 * - thinking: caller override first, then persona default (orchestrator selects per delegation).
 * - maxTurns, isolation, inheritContext: persona policy first, then
 *   caller value.
 * - runInBackground: in interactive sessions (defaultRunInBackground true)
 *   the order is persona policy → caller value → background default. In
 *   headless sessions (false) persona pins are IGNORED and only an explicit
 *   caller value can opt into background — backgrounded work can outlive a
 *   headless process, so automation keeps it an explicit per-call choice.
 */
export function resolveAgentInvocationConfig(
	agentConfig: AgentConfig | undefined,
	params: AgentInvocationParams,
	/**
	 * Interactive-session signal: true when the session has a UI loop that
	 * can consume completion notifications. Interactive sessions default to
	 * background (persona pin and caller value still take precedence).
	 * Headless sessions default to foreground AND ignore persona pins — only
	 * an explicit caller opt-in backgrounds work, since backgrounded agents
	 * would outlive the process.
	 */
	defaultRunInBackground = true,
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

	if (params.model) {
		modelInput = params.model
		modelFromParams = true
	}

	return {
		modelInput,
		modelFromParams,
		thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
		maxTurns: agentConfig?.maxTurns ?? params.max_turns,
		tokenBudget: params.token_budget ?? params.tokenBudget ?? agentConfig?.tokenBudget,
		maxDuration: params.max_duration ?? agentConfig?.maxDuration,
		inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
		runInBackground: defaultRunInBackground
			? (agentConfig?.runInBackground ?? params.run_in_background ?? true)
			: (params.run_in_background ?? false),
		isolated: agentConfig?.isolated ?? params.isolated ?? false,
		isolation: agentConfig?.isolation ?? params.isolation,
	}
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
	return runInBackground ? defaultJoinMode : undefined
}
