import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AgentOutcomeKind, AgentRecord, SubagentType } from "./agents/personas/types.js"
import { getCurrentPhase } from "./tags.js"

const IMPLEMENTATION_TOOLS = new Set(["edit", "write"])

export interface OrchestratorWriteGuardOptions {
	/** Tools that count as implementation work. Default: edit, write. */
	implementationTools?: Set<string>
	/** Number of implementation tool calls after a successful subagent return in build phase before a steer fires. Default: 2 */
	buildPhaseThreshold?: number
	/** Number of implementation tool calls after a successful subagent return in build phase before a hard block fires. Default: 5 */
	buildPhaseBlockThreshold?: number
	/**
	 * Number of implementation tool calls after a failed/stopped/aborted subagent return
	 * before a steer fires. Default: 3 — higher than the success threshold because the
	 * orchestrator is doing triage, not stealing a successful worker's output.
	 */
	buildPhaseTriageThreshold?: number
	/**
	 * Number of implementation tool calls after a failed/stopped/aborted subagent return
	 * before a hard block fires. Default: 6.
	 */
	buildPhaseTriageBlockThreshold?: number
}

export const STEER_MESSAGE_TYPE = "review-write-guard-steer"

const REVIEW_BLOCK_REASON =
	"BLOCKED: You are in the review phase. The orchestrator must not edit implementation files during review. " +
	"Delegate fixes to a build agent instead — spawn an Agent with the fix task and the list of issues."

const BUILD_STEER_MESSAGE =
	"Delegation guard: you are editing files that a subagent produced. " +
	"The orchestrator should not fix subagent output directly — it wastes orchestrator tokens. " +
	"Spawn a fix Agent with the test failures and let it handle the corrections."

const BUILD_BLOCK_REASON =
	"BLOCKED: You have continued editing subagent output after being warned. " +
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
	private readonly ctx: ExtensionContext

	private readonly implementationTools: Set<string>
	private readonly buildPhaseThreshold: number
	private readonly buildPhaseBlockThreshold: number
	private readonly buildPhaseTriageThreshold: number
	private readonly buildPhaseTriageBlockThreshold: number

	private subagentReturnedInBuild = false
	private lastSubagentSuccessful = false
	private buildWriteCount = 0
	private buildSteered = false

	constructor(ctx: ExtensionContext, options: OrchestratorWriteGuardOptions = {}) {
		this.ctx = ctx

		this.implementationTools = options.implementationTools ?? new Set(IMPLEMENTATION_TOOLS)
		this.buildPhaseThreshold = options.buildPhaseThreshold ?? 2
		this.buildPhaseBlockThreshold = options.buildPhaseBlockThreshold ?? 5
		this.buildPhaseTriageThreshold = options.buildPhaseTriageThreshold ?? 3
		this.buildPhaseTriageBlockThreshold = options.buildPhaseTriageBlockThreshold ?? 6

		if (this.buildPhaseThreshold >= this.buildPhaseBlockThreshold) {
			throw new Error("buildPhaseBlockThreshold must be greater than buildPhaseThreshold")
		}
		if (this.buildPhaseTriageThreshold >= this.buildPhaseTriageBlockThreshold) {
			throw new Error("buildPhaseTriageBlockThreshold must be greater than buildPhaseTriageThreshold")
		}
		if (this.buildPhaseTriageThreshold <= this.buildPhaseThreshold) {
			throw new Error("buildPhaseTriageThreshold must be greater than buildPhaseThreshold")
		}
		if (this.buildPhaseTriageBlockThreshold <= this.buildPhaseBlockThreshold) {
			throw new Error("buildPhaseTriageBlockThreshold must be greater than buildPhaseBlockThreshold")
		}
	}

	reset(): void {
		this.subagentReturnedInBuild = false
		this.lastSubagentSuccessful = false
		this.buildWriteCount = 0
		this.buildSteered = false
	}

	checkToolCall(toolName: string): { block: true; reason: string } | { steer: string } | undefined {
		const phase = getCurrentPhase(this.ctx.sessionManager.getSessionId())

		if (phase === "review" && this.implementationTools.has(toolName)) {
			return { block: true, reason: REVIEW_BLOCK_REASON }
		}

		if (phase === "build" && this.implementationTools.has(toolName)) {
			if (!this.subagentReturnedInBuild) return undefined

			this.buildWriteCount++
			const { steerThreshold, blockThreshold } = this.currentThresholds()

			if (this.buildWriteCount >= blockThreshold) {
				return { block: true, reason: BUILD_BLOCK_REASON }
			}
			if (this.buildWriteCount >= steerThreshold && !this.buildSteered) {
				this.buildSteered = true
				return { steer: BUILD_STEER_MESSAGE }
			}
		}

		if (phase !== "review" && phase !== "build") {
			this.reset()
		}

		return undefined
	}

	recordSubagentReturn(outcome?: AgentOutcomeSummary): void {
		const phase = getCurrentPhase(this.ctx.sessionManager.getSessionId())
		if (phase !== "build") {
			// A subagent return in a non-build phase should not arm the guard for a
			// later build phase; clear any stale build-phase state.
			this.reset()
			return
		}

		this.buildWriteCount = 0
		this.buildSteered = false

		if (isTriageOutcome(outcome)) {
			// Subagent did not complete successfully. The orchestrator is doing triage
			// on partial/failed/stopped worker output; allow more direct edits before
			// steering again. Keep the guard armed but use the higher triage thresholds.
			this.subagentReturnedInBuild = true
			this.lastSubagentSuccessful = false
			return
		}

		if (!isSuccessfulOutcome(outcome)) {
			// Unknown or non-success outcome: use triage thresholds rather than disarming,
			// so legacy/partial runtime outcomes still get some guard protection.
			this.subagentReturnedInBuild = true
			this.lastSubagentSuccessful = false
			return
		}

		this.subagentReturnedInBuild = true
		this.lastSubagentSuccessful = true
	}

	getState(): {
		subagentReturnedInBuild: boolean
		lastSubagentSuccessful: boolean
		buildWriteCount: number
		buildSteered: boolean
	} {
		return {
			subagentReturnedInBuild: this.subagentReturnedInBuild,
			lastSubagentSuccessful: this.lastSubagentSuccessful,
			buildWriteCount: this.buildWriteCount,
			buildSteered: this.buildSteered,
		}
	}

	private currentThresholds(): { steerThreshold: number; blockThreshold: number } {
		if (!this.lastSubagentSuccessful) {
			return {
				steerThreshold: this.buildPhaseTriageThreshold,
				blockThreshold: this.buildPhaseTriageBlockThreshold,
			}
		}
		return {
			steerThreshold: this.buildPhaseThreshold,
			blockThreshold: this.buildPhaseBlockThreshold,
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

export default function reviewWriteGuardExtension(pi: ExtensionAPI, options?: OrchestratorWriteGuardOptions): void {
	const guardMap = new Map<string, OrchestratorWriteGuard>()

	function getOrchestratorWriteGuard(ctx: ExtensionContext): OrchestratorWriteGuard {
		const sessionId = ctx.sessionManager.getSessionId()
		let guard = guardMap.get(sessionId)
		if (!guard) {
			guard = new OrchestratorWriteGuard(ctx, options)
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

	pi.on("tool_call", (event, ctx) => {
		if (!event.toolName) return

		// Agent calls are pass-through only. We deliberately do NOT reset the guard
		// here: spawning a new subagent must not create a disarm gap where the
		// orchestrator could edit freely while waiting for that subagent to return.
		// The guard resets its per-return counters only when a subagent actually
		// finishes (tool_result) or when the session/phase changes.
		if (event.toolName === "Agent") {
			return { block: false }
		}

		const guard = getOrchestratorWriteGuard(ctx)
		const result = guard.checkToolCall(event.toolName)
		if (!result) return { block: false }

		if ("block" in result) {
			return { block: true, reason: result.reason }
		}

		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: result.steer }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
		return { block: false }
	})

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "Agent") {
			const guard = getOrchestratorWriteGuard(ctx)
			guard.recordSubagentReturn(extractAgentOutcome(event))
		}
	})
}
