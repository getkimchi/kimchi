import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Registry of persona output-contract tools (AgentConfig.outputToolName).
 *
 * A persona with a bound submit tool (e.g. the Plan Reviewer's
 * `submit_plan_review`) must be able to CALL that tool inside its own subagent
 * session. The tool is owned by a higher-level extension (ferment registers
 * `submit_plan_review`), but subagent sessions do NOT load those higher-level
 * extensions — their resource loader only gets a minimal factory set. Without a
 * bridge the persona is told to call a tool that was never registered in its
 * session, and the run fails with "Tool ... not found".
 *
 * The owning extension registers its installer here at startup; the agent runner
 * injects every registered installer into each subagent's extension loader so the
 * tool exists in the session. The runner's per-persona gating then keeps each
 * output tool active only for its owning persona and strips it from the rest.
 */
export type PersonaOutputToolFactory = (pi: ExtensionAPI) => void

const factories = new Map<string, PersonaOutputToolFactory>()

/** Register the installer for a persona's bound submit tool. Idempotent per tool
 *  name (last registration wins). */
export function registerPersonaOutputToolFactory(toolName: string, factory: PersonaOutputToolFactory): void {
	factories.set(toolName, factory)
}

/** All registered persona output-tool installers, for injection into subagent
 *  extension loaders. */
export function getPersonaOutputToolFactories(): PersonaOutputToolFactory[] {
	return [...factories.values()]
}
