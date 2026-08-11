/**
 * Workflow domain events published via pi.events by @kimchi-dev/kimchi-workflows.
 *
 * MIRROR, not source: the canonical contract (channel, payload shapes) lives in the producer's
 * `src/host/telemetry-events.ts` (rationale in its `specs/telemetry.md`). Nothing is imported from
 * it by design, so drift is silent rather than a compile error — reconcile changes manually. This
 * file is the stepping stone to a shared contract package and should be deleted once one exists.
 *
 * Everything arrives on the single envelope {@link WORKFLOW_TELEMETRY_CHANNEL}, discriminated by
 * each payload's `event` field; translation policy lives in `handlers/workflows.ts`, consumer-facing
 * detail (correlation, privacy, retry semantics) in this folder's README.
 */

/** The single channel every workflow event arrives on. */
export const WORKFLOW_TELEMETRY_CHANNEL = "workflow:telemetry"

/**
 * Why a step attempt was retried — the producer's own vocabulary (translated from its engine's).
 * `provider_error`/`context_window` absorb agent-turn request failures into the retry they cause,
 * preserving the provider-failed-vs-model-misbehaved distinction without a separate agent event.
 */
export type WorkflowRetryReason =
	| "exception"
	| "invalid_output"
	| "budget_exceeded"
	| "provider_error"
	| "context_window"

/** The error envelope — the contract's only object field, one level of primitives. */
export interface WorkflowError {
	readonly message: string
}

/**
 * On every payload. `workflow_name` is author-declared (unique per project by convention); it is `""`
 * for a terminal event from a stale-lock reclaim — join those via `run_id`. `at` is the producer's ISO timestamp.
 */
export interface WorkflowEventCommon {
	readonly event: string
	readonly run_id: string
	readonly workflow_name: string
	readonly at: string
}

/** Step-scoped events add `step_name`: the leaf of the producer's node path — the only run structure exported (data minimization). */
export interface WorkflowStepEventCommon extends WorkflowEventCommon {
	readonly step_name: string
}

export interface WorkflowRunStartedPayload extends WorkflowEventCommon {
	readonly event: "run_started"
}

export interface WorkflowRunResumedPayload extends WorkflowEventCommon {
	readonly event: "run_resumed"
}

/** The run handed control back and waits on a human. What it waits FOR is the producer's run log's business. */
export interface WorkflowRunBlockedPayload extends WorkflowEventCommon {
	readonly event: "run_blocked"
}

export interface WorkflowRunCompletedPayload extends WorkflowEventCommon {
	readonly event: "run_completed"
	readonly duration_ms?: number
}

export interface WorkflowRunFailedPayload extends WorkflowEventCommon {
	readonly event: "run_failed"
	readonly error: WorkflowError
	readonly duration_ms?: number
}

export interface WorkflowRunCancelledPayload extends WorkflowEventCommon {
	readonly event: "run_cancelled"
}

export interface WorkflowStepStartedPayload extends WorkflowStepEventCommon {
	readonly event: "step_started"
}

export interface WorkflowStepRetriedPayload extends WorkflowStepEventCommon {
	readonly event: "step_retried"
	readonly attempt: number
	readonly reason: WorkflowRetryReason
	readonly error: WorkflowError
}

export interface WorkflowStepCompletedPayload extends WorkflowStepEventCommon {
	readonly event: "step_completed"
	readonly duration_ms?: number
}

/**
 * An `optional` step exhausted retries while the run carried on — for shipped workflows (most agent
 * steps are optional, so a run can complete "successfully" with many failed steps) this, not
 * `run_failed`, is the health signal.
 */
export interface WorkflowStepFailedPayload extends WorkflowStepEventCommon {
	readonly event: "step_failed"
	readonly error: WorkflowError
	readonly duration_ms?: number
}

export interface WorkflowStepCancelledPayload extends WorkflowStepEventCommon {
	readonly event: "step_cancelled"
}

/** Every payload the producer publishes today, discriminated by `event`. */
export type WorkflowEventPayload =
	| WorkflowRunStartedPayload
	| WorkflowRunResumedPayload
	| WorkflowRunBlockedPayload
	| WorkflowRunCompletedPayload
	| WorkflowRunFailedPayload
	| WorkflowRunCancelledPayload
	| WorkflowStepStartedPayload
	| WorkflowStepRetriedPayload
	| WorkflowStepCompletedPayload
	| WorkflowStepFailedPayload
	| WorkflowStepCancelledPayload
