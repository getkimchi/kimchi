/**
 * Ferment Agent spawn guard.
 *
 * Intercepts `Agent` tool calls at the orchestrator level. If the ferment
 * engine's next action is `start_step`, block the spawn and redirect the
 * orchestrator to call `start_ferment_step` first.
 *
 * Why: the orchestrator owns the ferment state machine. Before delegating
 * implementation work, it must call start_ferment_step to:
 *   - record the step as running in the ledger,
 *   - capture the git HEAD ref for phase/step evidence,
 *   - obtain the worker context, plan-first preamble, and parallel siblings,
 *   - enable stuck-loop detection,
 *   - let the forward engine know the step is in progress.
 *
 * If the orchestrator spawns a worker without starting the step first, the
 * ledger stays at "0 done", the engine keeps returning start_step as the next
 * action, and multiple uncoordinated agents can be spawned for the same work.
 *
 * Scope of enforcement:
 *   - Only blocks when engine.action.kind === "start_step". All other engine
 *     states (complete_step, recover_step, complete_phase, etc.) allow the
 *     spawn — those legitimately need helper agents (Explore, Reviewer).
 *   - Does NOT enforce the parallel-sibling "start all before spawning any"
 *     rule. The engine emits start_step for at most one pending step at a
 *     time and emits complete_step (not start_step) once any sibling is
 *     running, so the guard's engine-driven decision cannot reason about
 *     half-started cohorts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import { isAgentWorker } from "../agent-worker-context.js"
import type { FermentRuntime } from "./runtime.js"

export function registerAgentSpawnGuard(pi: ExtensionAPI, runtime: FermentRuntime): void {
	pi.on("tool_call", (event: { toolName?: string }) => {
		// The guard only applies to the orchestrator. Subagent workers cannot
		// spawn nested agents anyway (agent-runner.ts strips Agent), but this
		// makes the boundary explicit and future-proof.
		if (isAgentWorker()) return { block: false }

		// Only intercept Agent tool calls.
		if (event.toolName !== "Agent") return { block: false }

		return buildRedirectIfStartStepPending(runtime)
	})
}

function buildRedirectIfStartStepPending(runtime: FermentRuntime): { block: true; reason: string } | { block: false } {
	const ferment = runtime.getActive()

	// No active ferment → exploration or normal chat; allow.
	if (!ferment) return { block: false }

	// Ferment not running (draft/planned/paused/complete/abandoned) → allow.
	// The orchestrator should start phases/steps via normal ferment tools, not
	// by spawning agents.
	if (ferment.status !== "running") return { block: false }

	let action: ReturnType<typeof determineNextAction>
	try {
		action = determineNextAction(ferment)
	} catch {
		// Be permissive on malformed or drifted persisted state. The guard is
		// advisory enforcement; an engine error here must not break tool calls.
		return { block: false }
	}

	// Only block when the engine's next action is to start a step. If the next
	// action is complete_step, complete_phase, recover, etc., a worker spawn
	// may be legitimate (e.g. a Reviewer helper checking the running step's
	// output, an Explore helper looking up an example) and we leave it to the
	// orchestrator supplement to guide the model.
	if (action?.kind !== "start_step") return { block: false }

	const phase = ferment.phases.find((p) => p.id === action.phaseId)
	const step = phase?.steps.find((s) => s.id === action.stepId)

	// Be permissive on data drift; don't block if we can't describe the step.
	if (!phase || !step) return { block: false }

	return {
		block: true,
		reason: `Active ferment "${ferment.name}" has a pending step that has not been started yet.\n\nStep ${step.index} of phase ${phase.index}: "${step.description}"\n\nCall start_ferment_step first, then re-call Agent. The orchestrator owns ferment state transitions; a worker cannot start or complete steps on the ledger's behalf.`,
	}
}
