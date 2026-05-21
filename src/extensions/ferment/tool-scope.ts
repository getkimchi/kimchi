import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { type ToolVisibilityAPI, createToolVisibility } from "../prompt-construction/tool-visibility.js"
import type { FermentRuntime } from "./runtime.js"

export const FERMENT_TOOL_NAMES = [
	"propose_ferment_scoping",
	"list_ferments",
	"scope_ferment",
	"update_ferment_scope_field",
	"complete_ferment",
	"activate_ferment_phase",
	"refine_ferment_phase",
	"complete_ferment_phase",
	"skip_ferment_phase",
	"fail_ferment_phase",
	"start_ferment_step",
	"complete_ferment_step",
	"verify_ferment_step",
	"skip_ferment_step",
	"fail_ferment_step",
	"add_ferment_decision",
	"add_ferment_memory",
] as const

const FERMENT_TOOL_NAME_SET = new Set<string>(FERMENT_TOOL_NAMES)

export type FermentToolProfile = "idle" | "planner-active" | "paused-terminal" | "worker" | "oneshot-planner"

const IDLE_FERMENT_TOOL_NAMES = ["list_ferments"] as const
const PAUSED_TERMINAL_FERMENT_TOOL_NAMES = ["list_ferments"] as const

/**
 * Tools the planner is allowed to call directly in `ferment-oneshot` mode.
 * Everything else (bash, edit, write, web_search, grep, …) must be delegated
 * to a subagent worker — the whole point of one-shot orchestration is that
 * the planner orchestrates and workers execute.
 *
 * `read` stays available so `complete_ferment_step` can sanity-check a worker's diff
 * without spawning a verification subagent.
 * `get_subagent_result` is required for background Agent calls.
 * The ferment lifecycle surface itself is the same existing-ferment surface
 * used by normal active planners; creation is host-owned before either run starts.
 */
export const PLANNER_ONESHOT_ALLOWLIST = new Set<string>([
	...FERMENT_TOOL_NAMES,
	// Delegation tool: the higher-level persona-based `Agent`
	// (`src/extensions/agents/index.ts:590`). The orchestrator picks the
	// worker model from its registry; ferment no longer prescribes it.
	// `Agent` persists child sessions through the agents manager, so bench
	// session-linkage and token aggregation remain intact.
	"Agent",
	"get_subagent_result",
	"read",
	// Metadata-only phase tracker injected by the ferment planner supplement
	// when a ferment is active.
	// Taxonomy classifies it as readOnly (`taxonomy.ts`) — no side effects.
	"set_phase",
])

function registeredFermentToolNames(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => FERMENT_TOOL_NAME_SET.has(name))
}

function allowedFermentToolNamesForProfile(profile: FermentToolProfile): readonly string[] {
	switch (profile) {
		case "idle":
			return IDLE_FERMENT_TOOL_NAMES
		case "planner-active":
			return FERMENT_TOOL_NAMES
		case "oneshot-planner":
			return FERMENT_TOOL_NAMES
		case "paused-terminal":
			return PAUSED_TERMINAL_FERMENT_TOOL_NAMES
		case "worker":
			return []
	}
}

export function profileForFerment(ferment: Ferment | undefined): FermentToolProfile {
	if (isAgentWorker()) return "worker"
	if (!ferment) return "idle"
	if (ferment.status === "paused" || ferment.status === "complete" || ferment.status === "abandoned") {
		return "paused-terminal"
	}
	return "planner-active"
}

export class FermentToolScope {
	private readonly visibility: ToolVisibilityAPI

	constructor(private readonly pi: ExtensionAPI) {
		this.visibility = createToolVisibility(pi)
	}

	applyProfile(profile: FermentToolProfile): void {
		if (profile === "oneshot-planner") {
			// One-shot is an intentionally session-static allowlist that also
			// curates non-ferment tools. Treat it as the master profile instead
			// of mixing direct allowlist writes with cooperative ferment votes.
			applyPlannerOneshotAllowlist(this.pi)
			return
		}

		const registered = registeredFermentToolNames(this.pi)
		const allowed = new Set(allowedFermentToolNamesForProfile(profile))
		const allowedRegistered = registered.filter((name) => allowed.has(name))

		// Ferment owns only its own tools. Static profiles are applied before a
		// run starts; pi-mono will snapshot the resulting tool list for that run.
		this.visibility.disable(registered)
		this.visibility.enable(allowedRegistered)
	}
}

const scopesByPi = new WeakMap<ExtensionAPI, FermentToolScope>()

export function getFermentToolScope(pi: ExtensionAPI): FermentToolScope {
	let scope = scopesByPi.get(pi)
	if (!scope) {
		scope = new FermentToolScope(pi)
		scopesByPi.set(pi, scope)
	}
	return scope
}

export function applyFermentToolProfile(pi: ExtensionAPI, profile: FermentToolProfile): void {
	getFermentToolScope(pi).applyProfile(profile)
}

export function applyFermentRuntimeToolProfile(pi: ExtensionAPI, runtime: FermentRuntime): void {
	applyFermentToolProfile(pi, profileForFerment(runtime.getActive()))
}

export function setActiveFermentState(runtime: FermentRuntime, ferment: Ferment | undefined): void {
	runtime.setActive(ferment)
}

export function setActiveFermentAndApplyProfile(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
	ferment: Ferment | undefined,
): void {
	runtime.setActive(ferment)
	applyFermentToolProfile(pi, profileForFerment(ferment))
}

/**
 * In `ferment-oneshot` mode, restrict the planner's active tools to the
 * allowlist. Removes inline implementation tools (bash, edit, write,
 * web_search, grep, …) so the planner is structurally forced to delegate
 * via `Agent` instead of doing the work itself.
 *
 * Must be called after ferment tools are enabled (the allowlist includes
 * them) and only in the planner process — Agent workers need the full toolset
 * to do the actual work.
 */
export function applyPlannerOneshotAllowlist(pi: ExtensionAPI): void {
	const allowed = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => PLANNER_ONESHOT_ALLOWLIST.has(name))
	pi.setActiveTools(allowed)
}
