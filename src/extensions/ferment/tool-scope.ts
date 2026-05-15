import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import type { FermentRuntime } from "./runtime.js"

export const FERMENT_TOOL_NAMES = [
	"create_ferment",
	"propose_scoping",
	"list_ferments",
	"scope_ferment",
	"update_scope_field",
	"set_ferment_mode",
	"complete_ferment",
	"activate_phase",
	"refine_phase",
	"complete_phase",
	"skip_phase",
	"fail_phase",
	"start_step",
	"complete_step",
	"verify_step",
	"skip_step",
	"fail_step",
	"add_decision",
	"add_memory",
] as const

const FERMENT_TOOL_NAME_SET = new Set<string>(FERMENT_TOOL_NAMES)

/**
 * Tools the planner is allowed to call directly in `ferment-oneshot` mode.
 * Everything else (bash, edit, write, web_search, grep, …) must be delegated
 * to a subagent worker — the whole point of one-shot orchestration is that
 * the planner orchestrates and workers execute.
 *
 * `read` stays available so `complete_step` can sanity-check a worker's diff
 * without spawning a verification subagent.
 * `get_subagent_result` is required for background Agent calls.
 */
export const PLANNER_ONESHOT_ALLOWLIST = new Set<string>([
	...FERMENT_TOOL_NAMES,
	// Delegation tool: the higher-level persona-based `Agent`
	// (`src/extensions/agents/index.ts:590`). Planners pass the ferment's
	// per-step `worker_model` through `Agent`'s `model` parameter.
	// `Agent` uses the same prepareChildSessionFile pattern as the legacy
	// `subagent` primitive, so bench session-linkage and token aggregation
	// remain intact.
	"Agent",
	"get_subagent_result",
	"read",
	// Metadata-only phase tracker injected by the ferment planner supplement
	// when a ferment is active.
	// Taxonomy classifies it as readOnly (`taxonomy.ts`) — no side effects.
	"set_phase",
])

export function disableFermentTools(pi: ExtensionAPI): void {
	pi.setActiveTools(pi.getActiveTools().filter((name) => !FERMENT_TOOL_NAME_SET.has(name)))
}

export function enableFermentTools(pi: ExtensionAPI): void {
	const activeWithoutFerment = pi.getActiveTools().filter((name) => !FERMENT_TOOL_NAME_SET.has(name))
	const registeredFermentTools = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => FERMENT_TOOL_NAME_SET.has(name))

	pi.setActiveTools([...new Set([...activeWithoutFerment, ...registeredFermentTools])])
}

export function shouldEnableFermentTools(ferment: Ferment | undefined): boolean {
	return (
		ferment !== undefined &&
		ferment.status !== "paused" &&
		ferment.status !== "complete" &&
		ferment.status !== "abandoned"
	)
}

export function syncFermentToolScope(pi: ExtensionAPI, ferment: Ferment | undefined): void {
	if (shouldEnableFermentTools(ferment)) {
		enableFermentTools(pi)
	} else {
		disableFermentTools(pi)
	}
}

export function setActiveFerment(pi: ExtensionAPI, runtime: FermentRuntime, ferment: Ferment | undefined): void {
	runtime.setActive(ferment)
	syncFermentToolScope(pi, ferment)
}

/**
 * In `ferment-oneshot` mode, restrict the planner's active tools to the
 * allowlist. Removes inline implementation tools (bash, edit, write,
 * web_search, grep, …) so the planner is structurally forced to delegate
 * via `Agent` instead of doing the work itself.
 *
 * Must be called after ferment tools are enabled (the allowlist includes
 * them) and only in the planner process — subagents run with
 * `KIMCHI_SUBAGENT=1` and need the full toolset to do the actual work.
 */
export function applyPlannerOneshotAllowlist(pi: ExtensionAPI): void {
	const allowed = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => PLANNER_ONESHOT_ALLOWLIST.has(name))
	pi.setActiveTools(allowed)
}
