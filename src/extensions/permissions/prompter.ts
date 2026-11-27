import type { ApprovalOutcome } from "./prompts.js"
import type { RiskScore, Rule } from "./types.js"

export type PermissionChoice =
	| { kind: "allow-once"; label: string }
	| { kind: "allow-remember"; label: string; rules: Rule[] }
	| { kind: "allow-remember-wildcard"; label: string; rules: Rule[] }
	| { kind: "deny"; label: string }

/** The subagent a permission prompt is shown on behalf of, when a worker's
 *  call was escalated to its parent session's surface. */
export interface PermissionOrigin {
	persona?: string
	agentId?: string
	description?: string
}

export interface PermissionRequest {
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
	subtitle?: string
	/** Risk score from the classifier LLM, for display in the prompt. */
	riskScore?: RiskScore
	choices: PermissionChoice[]
	signal?: AbortSignal
	/** Set when a worker escalated this request to the parent session — the
	 *  prompt names the subagent so the user knows whose call it is. */
	origin?: PermissionOrigin

	// NOTE: remember choices carry multiple rules because compound bash
	// commands produce one rule per segment (the compound gate evaluates
	// segments independently and requires all of them allowed).
}

/**
 * Abort reason of a permission request that a mode change withdrew. The call
 * behind it is decided again under the new mode, so "aborted" for this reason
 * is not a denial.
 */
export const MODE_CHANGED_ABORT_ERROR = new Error("permissions: mode changed")

/**
 * Where a subagent's call stands after it was asked about in the parent
 * session: allowed and now running, or ended. `failed` covers a call that was
 * refused or blocked as well as one that ran and failed.
 */
export type EscalatedCallStatus = "running" | "completed" | "failed"

export interface EscalatedCallReport {
	/** The subagent's own id for the call, as in the request. */
	toolCallId: string
	agentId?: string
	status: EscalatedCallStatus
}

export interface ToolPermissionPrompter {
	request(req: PermissionRequest): Promise<ApprovalOutcome>
	/**
	 * A subagent's call that was asked about through this prompter has moved
	 * on. A surface that keeps a card for the call (ACP) updates it from this
	 * and never from the answer alone: allowing a call does not mean that it
	 * succeeded, and a withdrawn request does not mean that it failed. Best
	 * effort; must not throw.
	 */
	reportEscalatedCall?(report: EscalatedCallReport): void
}
