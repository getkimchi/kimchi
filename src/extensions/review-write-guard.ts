import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AgentOutcomeKind, AgentRecord, SubagentType } from "./agents/personas/types.js"
import { fermentDelegationIsStrict } from "./ferment/delegation-mode.js"
import { getMultiModelEnabled } from "./multi-model.js"
import { markHarnessSteer } from "./steer-marker.js"

const IMPLEMENTATION_TOOLS = new Set(["edit", "write"])

export interface OrchestratorWriteGuardOptions {
	/** Tools that count as implementation work. Default: edit, write. */
	implementationTools?: Set<string>
	/** Number of implementation tool calls after a successful subagent return before a steer fires. Default: 2 */
	steerThreshold?: number
	/** Number of implementation tool calls after a successful subagent return before a hard block fires. Default: 5 */
	blockThreshold?: number
	/**
	 * Number of implementation tool calls after a failed/stopped/aborted subagent return
	 * before a steer fires. Default: 3 — higher than the success threshold because the
	 * orchestrator is doing triage, not stealing a successful worker's output.
	 */
	triageSteerThreshold?: number
	/**
	 * Number of implementation tool calls after a failed/stopped/aborted subagent return
	 * before a hard block fires. Default: 6.
	 */
	triageBlockThreshold?: number
}

export const STEER_MESSAGE_TYPE = "review-write-guard-steer"

function buildSteerMessage(allowance: number): string {
	const calls = allowance === 1 ? "one small edit/write call" : `${allowance} small edit/write calls`
	return (
		"Delegation guard: you are editing implementation files after a subagent returned. " +
		`The direct-edit allowance is only for one trivial fix requiring up to ${calls} ` +
		"(a typo, missing import, or one-line config change). " +
		"If this fix is growing beyond that scope — multiple files, test expectations, iteration loops — stop and " +
		"delegate the remaining fixes to a build/fix agent instead: spawn an Agent with the fix task and the list of issues."
	)
}

const BLOCK_REASON =
	"BLOCKED: You have continued editing after being warned. " +
	"The orchestrator must not do a subagent's job. Spawn a fix Agent with the remaining work."

/** Subagent outcome shape exposed in the Agent tool's result details. */
interface AgentOutcomeSummary {
	/** Raw runtime status of the subagent. */
	status?: AgentRecord["status"]
	/** Stable classified result for orchestration decisions. */
	outcome?: AgentOutcomeKind
	/** Subagent persona, e.g. "Builder" | "Fixer" | "Explore". */
	subagentType?: SubagentType
}

// Undefined outcome defaults to successful. This preserves backward compatibility
// with subagent tool_results that do not yet include structured agentOutcome details;
// without it those legacy returns would fall back to the higher triage thresholds
// instead of the stricter success thresholds.
function isSuccessfulOutcome(outcome: AgentOutcomeSummary | undefined): boolean {
	if (!outcome) return true
	if (outcome.status === "steered" && outcome.outcome === "completed") return true
	return outcome.status === "completed" && outcome.outcome === "completed"
}

function isTriageOutcome(outcome: AgentOutcomeSummary | undefined): boolean {
	if (!outcome) return false
	const { status, outcome: result } = outcome
	// Explicit failure states observed from agent tool results.
	if (status === "aborted" || status === "stopped" || status === "error") return true
	return result === "failed" || result === "budget_exhausted" || result === "stopped"
}

export class OrchestratorWriteGuard {
	private readonly implementationTools: Set<string>
	private readonly steerThreshold: number
	private readonly blockThreshold: number
	private readonly triageSteerThreshold: number
	private readonly triageBlockThreshold: number
	private armed = false
	private lastSubagentSuccessful = false
	private writeCount = 0
	private steered = false

	constructor(options: OrchestratorWriteGuardOptions = {}) {
		this.implementationTools = options.implementationTools ?? new Set(IMPLEMENTATION_TOOLS)
		this.steerThreshold = options.steerThreshold ?? 2
		this.blockThreshold = options.blockThreshold ?? 5
		this.triageSteerThreshold = options.triageSteerThreshold ?? 3
		this.triageBlockThreshold = options.triageBlockThreshold ?? 6
		if (this.steerThreshold >= this.blockThreshold) {
			throw new Error("blockThreshold must be greater than steerThreshold")
		}
		if (this.triageSteerThreshold >= this.triageBlockThreshold) {
			throw new Error("triageBlockThreshold must be greater than triageSteerThreshold")
		}
		if (this.triageSteerThreshold <= this.steerThreshold) {
			throw new Error("triageSteerThreshold must be greater than steerThreshold")
		}
		if (this.triageBlockThreshold <= this.blockThreshold) {
			throw new Error("triageBlockThreshold must be greater than blockThreshold")
		}
	}

	reset(): void {
		this.armed = false
		this.lastSubagentSuccessful = false
		this.writeCount = 0
		this.steered = false
	}

	checkToolCall(toolName: string): { block: true; reason: string } | { steer: string } | undefined {
		if (!this.armed || !this.implementationTools.has(toolName)) return undefined

		this.writeCount++
		const { steerThreshold, blockThreshold } = this.currentThresholds()

		if (this.writeCount >= blockThreshold) {
			return { block: true, reason: BLOCK_REASON }
		}
		if (this.writeCount >= steerThreshold && !this.steered) {
			this.steered = true
			return { steer: buildSteerMessage(steerThreshold) }
		}

		return undefined
	}

	recordSubagentReturn(outcome?: AgentOutcomeSummary): void {
		// Arm on any subagent return. The guard stays armed for the remainder
		// of this user turn; pi.on("agent_start") resets at the next user prompt.
		this.armed = true
		this.writeCount = 0
		this.steered = false

		if (isTriageOutcome(outcome)) {
			// Subagent did not complete successfully. The orchestrator is doing triage
			// on partial/failed/stopped worker output; allow more direct edits before
			// steering again. Keep the guard armed but use the higher triage thresholds.
			this.lastSubagentSuccessful = false
			return
		}

		if (!isSuccessfulOutcome(outcome)) {
			// Unknown or non-success outcome: use triage thresholds rather than disarming,
			// so legacy/partial runtime outcomes still get some guard protection.
			this.lastSubagentSuccessful = false
			return
		}

		this.lastSubagentSuccessful = true
	}

	getState(): {
		armed: boolean
		lastSubagentSuccessful: boolean
		writeCount: number
		steered: boolean
	} {
		return {
			armed: this.armed,
			lastSubagentSuccessful: this.lastSubagentSuccessful,
			writeCount: this.writeCount,
			steered: this.steered,
		}
	}

	private currentThresholds(): { steerThreshold: number; blockThreshold: number } {
		if (!this.lastSubagentSuccessful) {
			return {
				steerThreshold: this.triageSteerThreshold,
				blockThreshold: this.triageBlockThreshold,
			}
		}
		return {
			steerThreshold: this.steerThreshold,
			blockThreshold: this.blockThreshold,
		}
	}
}

const AGENT_RECORD_STATUSES: AgentRecord["status"][] = [
	"queued",
	"running",
	"completed",
	"steered",
	"aborted",
	"stopped",
	"error",
]

const AGENT_OUTCOME_KINDS: AgentOutcomeKind[] = ["completed", "budget_exhausted", "failed", "stopped"]

function extractAgentOutcome(event: { details?: unknown }): AgentOutcomeSummary | undefined {
	const details = event.details
	if (!details || typeof details !== "object") return undefined

	const agentOutcome = (details as Record<string, unknown>).agentOutcome
	if (!agentOutcome || typeof agentOutcome !== "object") return undefined

	const ao = agentOutcome as Record<string, unknown>
	const rawStatus = typeof ao.status === "string" ? ao.status : undefined
	const rawOutcome = typeof ao.outcome === "string" ? ao.outcome : undefined
	const detailsSubagentType = (details as Record<string, unknown>).subagentType

	const status = AGENT_RECORD_STATUSES.includes(rawStatus as AgentRecord["status"])
		? (rawStatus as AgentRecord["status"])
		: undefined
	const outcome = AGENT_OUTCOME_KINDS.includes(rawOutcome as AgentOutcomeKind)
		? (rawOutcome as AgentOutcomeKind)
		: undefined

	return {
		status,
		outcome,
		subagentType:
			typeof ao.subagentType === "string"
				? ao.subagentType
				: typeof detailsSubagentType === "string"
					? detailsSubagentType
					: undefined,
	}
}

function isBackgroundAcknowledgement(event: { details?: unknown }): boolean {
	const details = event.details
	if (!details || typeof details !== "object") return false
	const record = details as Record<string, unknown>
	return record.status === "background" && !record.agentOutcome
}

/**
 * Whether the orchestrator is expected to delegate implementation work rather
 * than perform it — the premise the guard enforces.
 *
 * That premise only holds in multi-model sessions. Single-model prompts tell
 * the model the opposite: the base prompt says "do not spawn subagents with
 * the `Agent` tool by default", and ferment's relaxed mode (single-model)
 * instructs the planner to "execute steps directly with bash/edit/write".
 * Arming the guard there steers and then hard-blocks the exact behaviour the
 * prompt asks for, telling the model to "spawn a fix Agent" it was told not to
 * spawn.
 *
 * Multi-model is therefore the whole condition: it is what makes ferment
 * strict, and what makes delegation the default outside ferment.
 */
function delegationRequired(ctx: ExtensionContext): boolean {
	return fermentDelegationIsStrict(getMultiModelEnabled(ctx.sessionManager))
}

export interface ReviewWriteGuardExtensionOptions extends OrchestratorWriteGuardOptions {
	/** Overrides the delegation-required policy. Testing seam. */
	isDelegationRequired?: (ctx: ExtensionContext) => boolean
}

export default function reviewWriteGuardExtension(pi: ExtensionAPI, options?: ReviewWriteGuardExtensionOptions): void {
	const guardMap = new Map<string, OrchestratorWriteGuard>()
	const isDelegationRequired = options?.isDelegationRequired ?? delegationRequired

	function getOrchestratorWriteGuard(ctx: ExtensionContext): OrchestratorWriteGuard {
		const sessionId = ctx.sessionManager.getSessionId()
		let guard = guardMap.get(sessionId)
		if (!guard) {
			guard = new OrchestratorWriteGuard(options)
			guardMap.set(sessionId, guard)
		}
		return guard
	}

	pi.on("session_start", (_event, ctx) => {
		const guard = getOrchestratorWriteGuard(ctx)
		guard.reset()
	})

	pi.on("session_shutdown", (_event, ctx) => {
		guardMap.delete(ctx.sessionManager.getSessionId())
	})

	// Reset counters at the user-prompt boundary so the guard does not hard-block
	// edits in a later user turn after a delegation. Without this, the counter
	// would persist armed state across user prompts, trapping the user at the
	// block threshold with no escape hatch.
	//
	// NOTE: this MUST be `agent_start`, not `turn_start`. pi-agent-core's
	// runAgentLoop emits `agent_start` once per user prompt (agent-loop.js:67)
	// but re-emits `turn_start` on EVERY inner-loop iteration (agent-loop.js:88-92:
	// `if (!firstTurn) emit turn_start`). A delegation turn therefore looks like:
	//   agent_start -> turn_start -> tool_result(Agent) [arms] -> turn_start [next iter]
	// so resetting on `turn_start` would disarm the guard between the Agent
	// result and the orchestrator's subsequent edits, making the steer/block
	// paths unreachable in the intended flow. `agent_start` is the only event
	// that fires once per user prompt and survives across iterations.
	pi.on("agent_start", (_event, ctx) => {
		const guard = guardMap.get(ctx.sessionManager.getSessionId())
		if (guard) guard.reset()
	})

	pi.on("tool_call", (event, ctx) => {
		if (!event.toolName) return

		// Agent calls are pass-through only. We deliberately do NOT reset the guard
		// here: spawning a new subagent must not create a disarm gap where the
		// orchestrator could edit freely while waiting for that subagent to return.
		// The guard resets its per-return counters only when a subagent actually
		// finishes (tool_result) or at the user-prompt boundary (agent_start).
		if (event.toolName === "Agent") {
			return { block: false }
		}

		// Relaxed-mode ferment: direct execution is the instructed path, so the
		// guard must not steer or block it.
		if (!isDelegationRequired(ctx)) return { block: false }

		const guard = getOrchestratorWriteGuard(ctx)
		const result = guard.checkToolCall(event.toolName)
		if (!result) return { block: false }

		if ("block" in result) {
			return { block: true, reason: result.reason }
		}

		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: markHarnessSteer(result.steer) }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
		return { block: false }
	})

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "Agent") {
			// A background Agent result is only an acknowledgement that work was
			// queued. The terminal outcome arrives via get_subagent_result.
			if (isBackgroundAcknowledgement(event)) return
			const guard = getOrchestratorWriteGuard(ctx)
			// A ferment can activate mid-turn, after the guard was already armed.
			// Reset rather than arm so the orchestrator is not left throttled under
			// a policy that no longer applies to it.
			if (!isDelegationRequired(ctx)) {
				guard.reset()
				return
			}
			guard.recordSubagentReturn(extractAgentOutcome(event))
			return
		}

		// Only a terminal get_subagent_result carries a worker outcome. Ignore
		// status-only polling results so running/queued workers cannot arm the guard.
		if (event.toolName === "get_subagent_result") {
			const outcome = extractAgentOutcome(event)
			if (!outcome) return
			const guard = getOrchestratorWriteGuard(ctx)
			if (!isDelegationRequired(ctx)) {
				guard.reset()
				return
			}
			guard.recordSubagentReturn(outcome)
		}
	})
}
