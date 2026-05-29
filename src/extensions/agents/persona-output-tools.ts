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
 * The owning extension registers its installer here at startup; for each subagent
 * the agent runner injects ONLY that persona's own installer into its extension
 * loader, so the tool exists in its session and no other persona's output tool is
 * ever present.
 */
export type PersonaOutputToolFactory = (pi: ExtensionAPI) => void

const factories = new Map<string, PersonaOutputToolFactory>()

/** Register the installer for a persona's bound submit tool. Idempotent per tool
 *  name (last registration wins). */
export function registerPersonaOutputToolFactory(toolName: string, factory: PersonaOutputToolFactory): void {
	factories.set(toolName, factory)
}

/** The installer for one persona's bound submit tool, or undefined if none is
 *  registered under that name. The agent runner injects ONLY the owning persona's
 *  output tool into its subagent session, so foreign output tools never enter and
 *  need no per-persona stripping. */
export function getPersonaOutputToolFactory(toolName: string): PersonaOutputToolFactory | undefined {
	return factories.get(toolName)
}
