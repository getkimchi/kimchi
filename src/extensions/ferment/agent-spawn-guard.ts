/**
 * Ferment Agent spawn guard.
 *
 * Intercepts `Agent` tool calls at the orchestrator level and blocks the
 * spawn when the target ferment step has not been started yet.
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
 * Enforcement is argument-aware:
 *   - When the Agent call carries a `task_ref` pointing at a ferment step,
 *     the guard checks the TARGET step's state: allows if running, blocks if
 *     pending, allows if terminal (resume, review, etc.).
 *   - When `task_ref` is absent (helper agents like Explore, Reviewer that are
 *     not linked to a specific step), the guard falls back to an engine-based
 *     check: blocks only when the engine's next action is `start_step`, allows
 *     on `complete_step` / `complete_phase` / `recover` / etc.
 *
 * The argument-aware path prevents a structural deadlock in multi-step phases:
 * when step-1 is running and step-2 is pending (non-parallel), the engine
 * returns `complete_step` for step-1. An Agent call with `task_ref.step_id`
 * pointing at step-1 (running) is allowed, even though the engine's fallback
 * would have blocked on `start_step` for step-2.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import { isAgentWorker } from "../agent-worker-context.js"
import type { FermentRuntime } from "./runtime.js"

/** Shape of the Agent tool's task_ref argument. */
interface AgentTaskRef {
	kind: "ferment_step"
	ferment_id: string
	phase_id: string
	step_id: string
}

export function registerAgentSpawnGuard(pi: ExtensionAPI, runtime: FermentRuntime): void {
	pi.on("tool_call", (event: { toolName?: string; input?: Record<string, unknown> }) => {
		// The guard only applies to the orchestrator. Subagent workers cannot
		// spawn nested agents anyway (agent-runner.ts strips Agent), but this
		// makes the boundary explicit and future-proof.
		if (isAgentWorker()) return { block: false }

		// Only intercept Agent tool calls.
		if (event.toolName !== "Agent") return { block: false }

		return buildRedirect(runtime, event.input)
	})
}

function buildRedirect(
	runtime: FermentRuntime,
	input: Record<string, unknown> | undefined,
): { block: true; reason: string } | { block: false } {
	const ferment = runtime.getActive()

	// No active ferment → exploration or normal chat; allow.
	if (!ferment) return { block: false }

	// Ferment not running (draft/planned/paused/complete/abandoned) → allow.
	if (ferment.status !== "running") return { block: false }

	const taskRef = readTaskRef(input)

	// Argument-aware path: the Agent call references a specific ferment step.
	// Check the TARGET step's state, not sibling state.
	if (taskRef) {
		return checkTargetStep(ferment, taskRef)
	}

	// Fallback path: no task_ref (helper agents like Explore, Reviewer).
	// Fall back to engine-based check: block only on start_step.
	return buildRedirectIfStartStepPending(ferment)
}

function checkTargetStep(
	ferment: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	ref: AgentTaskRef,
): { block: true; reason: string } | { block: false } {
	// Reject stale or foreign task_refs whose ferment_id does not match the
	// active ferment. Phase/step IDs like "phase-1" / "step-1" are commonly
	// reused across ferments, so without this check a stale task_ref from a
	// previous ferment would silently match the active ferment's step-1 and
	// be allowed or blocked based on the wrong ferment's step state —
	// breaking the "check the target step" guarantee.
	if (ref.ferment_id !== ferment.id) {
		return {
			block: true,
			reason: `Agent task_ref references ferment ${ref.ferment_id}, but the active ferment is ${ferment.id} ("${ferment.name}"). The task_ref is stale or belongs to a different ferment.

Start a step on the active ferment via start_ferment_step first, then re-call Agent with an updated task_ref.`,
		}
	}

	const phase = ferment.phases.find((p) => p.id === ref.phase_id)
	const step = phase?.steps.find((s) => s.id === ref.step_id)

	// Be permissive on data drift; don't block if we can't find the step.
	if (!phase || !step) return { block: false }

	// Target step is running → Agent dispatch is legitimate (worker for the
	// active step, a resume, a Reviewer checking output, etc.).
	if (step.status === "running") return { block: false }

	// Target step is pending → block: the orchestrator must call
	// start_ferment_step before delegating work for this step.
	if (step.status === "pending") {
		return {
			block: true,
			reason: `Agent task_ref points at step ${step.index} of phase ${phase.index}: "${step.description}", which has not been started yet.\n\nCall start_ferment_step first, then re-call Agent. The orchestrator owns ferment state transitions; a worker cannot start or complete steps on the ledger's behalf.`,
		}
	}

	// Target step is terminal (done/skipped/verified/failed) → allow.
	// The orchestrator may be dispatching a Reviewer to verify completed work,
	// a Fixer to retry a failed step, etc.
	return { block: false }
}

function buildRedirectIfStartStepPending(
	ferment: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
): { block: true; reason: string } | { block: false } {
	let action: ReturnType<typeof determineNextAction>
	try {
		action = determineNextAction(ferment)
	} catch {
		// Be permissive on malformed or drifted persisted state.
		return { block: false }
	}

	// Only block when the engine's next action is to start a step. If the next
	// action is complete_step, complete_phase, recover, etc., a worker spawn
	// may be legitimate (e.g. a Reviewer helper checking the running step's
	// output, an Explore helper looking up an example).
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

/** Extracts and validates a ferment-step task_ref from the Agent tool's input. */
function readTaskRef(input: unknown): AgentTaskRef | undefined {
	if (!input || typeof input !== "object") return undefined
	const ref = (input as Record<string, unknown>).task_ref as Partial<AgentTaskRef> | undefined
	if (
		ref?.kind === "ferment_step" &&
		typeof ref.ferment_id === "string" &&
		typeof ref.phase_id === "string" &&
		typeof ref.step_id === "string"
	) {
		return {
			kind: "ferment_step",
			ferment_id: ref.ferment_id,
			phase_id: ref.phase_id,
			step_id: ref.step_id,
		}
	}
	return undefined
}
