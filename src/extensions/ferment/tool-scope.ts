import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { isAgentWorker } from "../agent-worker-context.js"
import type { FermentRuntime } from "./runtime.js"
import { FERMENT_TOOLS, isFermentOnlyToolName } from "./tool-names.js"

/**
 * Tools available during the planning phase of a ferment lifecycle.
 * Includes read-only discovery tools, web search, and the ferment scoping surface.
 *
 * `activate_ferment_phase` is included here even though it transitions the
 * ferment into the implementation phase — the prompt explicitly tells the
 * planner to call it as the first lifecycle action. Without it, the planner
 * has no way to fire the planning → implementation transition from within
 * the planning profile.
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
	// activate_ferment_phase fires the planning → implementation transition.
	// start_ferment_step and the rest of the implementation lifecycle tools are
	// NOT listed here — they become available on the turn after activation via
	// agent.prepareNextTurn refreshing context.tools from state.tools
	// (see patches/@earendil-works__pi-coding-agent.patch).
	FERMENT_TOOLS.ACTIVATE_PHASE,
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

/**
 * Profile applied to the planner's active tool list. Keyed on ferment
 * lifecycle state:
 *   - `idle`: no active ferment; all non-ferment tools + ferment discovery
 *             tools only (`list_ferments`, `request_ferment_workflow`). All
 *             ferment-only lifecycle/planning tools are hidden.
 *   - `worker`: subagent worker context (`KIMCHI_SUBAGENT=1`); empty toolset,
 *               managed externally by the agents manager
 *   - `planning`: ferment exists, no phase activated yet; read-only research
 *                 set + ferment planning tools
 *   - `implementation`: ferment has at least one activated phase; full toolset
 *                       (planning tools + bash, edit, write, Agent, etc.)
 *
 * The transition from `planning` to `implementation` fires on the first
 * successful `activate_ferment_phase` call. Paused, complete, and abandoned
 * ferments keep the profile they last had.
 */
export type FermentToolProfile = "idle" | "worker" | "planning" | "implementation"

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
	constructor(private readonly pi: ExtensionAPI) {}

	applyProfile(profile: FermentToolProfile): void {
		// Map FermentToolProfile ("idle"|"worker"|"planning"|"implementation") to
		// ToolProfile ("idle"|"worker"|"planning-ferment"|"implementation-ferment")
		// so ToolProfileManager.apply() can route to the right catalog entries.
		const catalogProfile = (
			profile === "planning" ? "planning-ferment" : profile === "implementation" ? "implementation-ferment" : profile
		) as "idle" | "worker" | "planning-ferment" | "implementation-ferment"
		ToolProfileManager.apply(catalogProfile, "ferment", this.pi)
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
