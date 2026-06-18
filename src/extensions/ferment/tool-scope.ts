import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { type ToolVisibilityAPI, createToolVisibility } from "../prompt-construction/tool-visibility.js"
import type { FermentRuntime } from "./runtime.js"
import { FERMENT_TOOLS, FERMENT_TOOL_NAMES, isFermentToolName } from "./tool-names.js"

// TODO(step3): `planner-active` is the legacy name for the implementation phase.
// In a later step, update callers to use "implementation" directly.
export type FermentToolProfile =
	| "idle"
	| "planner-active"
	| "paused-terminal"
	| "worker"
	| "oneshot-planner"
	| "planning"
	| "implementation"

const PAUSED_TERMINAL_FERMENT_TOOL_NAMES = [FERMENT_TOOLS.LIST] as const

/**
 * Tools available during the planning phase of a ferment lifecycle.
 * Includes read-only discovery tools, web search, and the ferment scoping surface.
 */
export const PLANNING_TOOL_NAMES: ReadonlySet<string> = new Set([
	// Read-only discovery tools
	"read",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	// Phase tracker injected by the ferment planner supplement
	"set_phase",
	// Ferment planning tools
	FERMENT_TOOLS.PROPOSE_SCOPING,
	FERMENT_TOOLS.SCOPE,
	FERMENT_TOOLS.UPDATE_SCOPE_FIELD,
	FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA,
	FERMENT_TOOLS.LIST,
	FERMENT_TOOLS.ASK_USER,
])

/**
 * Tools available during the implementation phase of a ferment lifecycle.
 * Includes all planning tools plus the full execution surface (bash, edit, write, Agent, etc.).
 */
export const IMPLEMENTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
	...PLANNING_TOOL_NAMES,
	// Execution tools
	"bash",
	"edit",
	"write",
	// Delegation tool: the higher-level persona-based `Agent`
	"Agent",
	"get_subagent_result",
	// Ferment lifecycle tools
	FERMENT_TOOLS.ACTIVATE_PHASE,
	FERMENT_TOOLS.REFINE_PHASE,
	FERMENT_TOOLS.COMPLETE_PHASE,
	FERMENT_TOOLS.SKIP_PHASE,
	FERMENT_TOOLS.FAIL_PHASE,
	FERMENT_TOOLS.START_STEP,
	FERMENT_TOOLS.COMPLETE_STEP,
	FERMENT_TOOLS.VERIFY_STEP,
	FERMENT_TOOLS.SKIP_STEP,
	FERMENT_TOOLS.FAIL_STEP,
	FERMENT_TOOLS.ADD_DECISION,
	FERMENT_TOOLS.ADD_MEMORY,
	FERMENT_TOOLS.COMPLETE,
])

// TODO(stepX): Remove `PLANNER_ONESHOT_ALLOWLIST` once the unified profile system
// replaces all callers of `applyPlannerOneshotAllowlist`. The static allowlist
// approach is superseded by the lifecycle-phase-based profile (planning/implementation).
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
		.filter((name) => isFermentToolName(name))
}

function allowedFermentToolNamesForProfile(profile: FermentToolProfile): readonly string[] {
	switch (profile) {
		case "idle":
			return []
		case "planner-active":
			return FERMENT_TOOL_NAMES
		case "oneshot-planner":
			return FERMENT_TOOL_NAMES
		case "paused-terminal":
			return PAUSED_TERMINAL_FERMENT_TOOL_NAMES
		case "worker":
			return []
		case "planning":
			return FERMENT_TOOL_NAMES
		case "implementation":
			return FERMENT_TOOL_NAMES
	}
}

export function profileForFerment(ferment: Ferment | undefined): FermentToolProfile {
	if (isAgentWorker()) return "worker"
	if (!ferment) return "idle"
	// A phase has been activated once its status is no longer "planned".
	// If any phase has been activated, the ferment is in implementation phase.
	// Otherwise it is in planning phase. Defensive against partial Ferment
	// objects (e.g. a draft ferment before phases are populated) where
	// ferment.phases may be undefined.
	const phases = ferment.phases ?? []
	const hasActivatedPhase = phases.some((phase) => phase.status !== "planned")
	return hasActivatedPhase ? "implementation" : "planning"
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

		if (profile === "planner-active") {
			// Legacy behavior via visibility — kept during deprecation transition.
			// Callers should migrate to "implementation" or "planning".
			const registered = registeredFermentToolNames(this.pi)
			const allowed = new Set(allowedFermentToolNamesForProfile(profile))
			const allowedRegistered = registered.filter((name) => allowed.has(name))

			// Ferment owns only its own tools. Static profiles are applied before a
			// run starts; pi-mono will snapshot the resulting tool list for that run.
			this.visibility.disable(registered)
			this.visibility.enable(allowedRegistered)
			return
		}

		// Unified profile system: use pi.setActiveTools() directly.
		switch (profile) {
			case "idle":
				this.pi.setActiveTools([...IDLE_FERMENT_TOOL_NAMES])
				break
			case "planning": {
				// Intersection: only tools that are BOTH registered AND explicitly listed for planning.
				const allTools = this.pi.getAllTools().map((tool) => tool.name)
				const allowed = allTools.filter((name) => PLANNING_TOOL_NAMES.has(name))
				this.pi.setActiveTools(allowed)
				break
			}
			case "implementation": {
				// Full toolset from registration, with guaranteed tools added defensively.
				const allTools = this.pi.getAllTools().map((tool) => tool.name)
				const allowed = new Set<string>(allTools)
				for (const required of IMPLEMENTATION_TOOL_NAMES) {
					allowed.add(required)
				}
				this.pi.setActiveTools([...allowed])
				break
			}
			case "paused-terminal":
				this.pi.setActiveTools([...PAUSED_TERMINAL_FERMENT_TOOL_NAMES])
				break
			case "worker":
				this.pi.setActiveTools([])
				break
		}
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

export function setActiveFermentAndApplyProfile(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
	ferment: Ferment | undefined,
): void {
	runtime.setActive(ferment)
	applyFermentToolProfile(pi, profileForFerment(ferment))
}

// TODO(stepX): Remove `applyPlannerOneshotAllowlist` once the unified profile system
// replaces all callers. The "oneshot-planner" profile case above delegates here during
// the transition period; after that, "implementation" handles the same behavior.
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
