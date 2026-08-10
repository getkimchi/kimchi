import { debugLog } from "./debug.js"
import type { CouncilRunContext, RunFailure } from "./run-context.js"
import type { FusionAnalysis } from "./schemas.js"
import type { CouncilStageRuntime, StructuredStageResult } from "./stage-runner.js"
import { safeFailureReason } from "./telemetry.js"
import type {
	CouncilDegradedReason,
	CouncilModelPool,
	CouncilTransactionProgressPhase,
	SafeCouncilFailureReason,
} from "./types.js"

export interface FusionSolverAssignment {
	index: number
	pool: CouncilModelPool
}

export interface FusionSynthesisArtifact<T> {
	artifact: T
	summary?: string
}

export interface FusionOutcome<T> {
	artifact: T
	analysis: FusionAnalysis
	summary?: string
}

export interface FusionPipelineDeps {
	run: CouncilRunContext
	stageRuntime: CouncilStageRuntime
	terminalFailureCode: (error: unknown) => RunFailure["code"] | undefined
	parentAborted: () => boolean
	failActiveStages: (reason: SafeCouncilFailureReason) => void
	emitTransactionProgress?: (phase: CouncilTransactionProgressPhase) => void
}

export interface FusionPanel<T> {
	panelSize: number
	pools: readonly CouncilModelPool[]
	maxConcurrentCalls: number
	run: (assignment: FusionSolverAssignment, deadline: number) => Promise<StructuredStageResult<T> | undefined>
}

export interface FusionComparison<T> {
	/** Drops candidates that cannot be compared (e.g. an unrenderable patch); identity where nothing can fail. */
	usable: (candidates: readonly T[]) => Promise<readonly T[]>
	runAnalyst: (candidates: readonly T[], deadline: number) => Promise<StructuredStageResult<FusionAnalysis> | undefined>
	runSynthesis: (
		candidates: readonly T[],
		analysis: FusionAnalysis,
		deadline: number,
	) => Promise<StructuredStageResult<FusionSynthesisArtifact<T>> | undefined>
	/** Fast preset only: replaces the separate analyst + synthesis calls with one combined call. */
	runCombined?: (
		candidates: readonly T[],
		deadline: number,
	) => Promise<StructuredStageResult<FusionSynthesisArtifact<T> & { analysis: FusionAnalysis }> | undefined>
}

export interface FusionPipelineOptions<T> {
	stageTimeoutMs: number
	leadArtifact: T
	panel: FusionPanel<T>
	comparison: FusionComparison<T>
	/** Promotes the lead's own artifact as the turn's result, tagged with the given degraded reason. */
	promoteLeadArtifact: (reason: CouncilDegradedReason) => Promise<void> | void
}

function buildSolverAssignments(panelSize: number, pools: readonly CouncilModelPool[]): FusionSolverAssignment[] {
	return Array.from({ length: Math.max(0, panelSize - 1) }, (_, index) => ({
		index: index + 1,
		pool: pools[index % pools.length],
	}))
}

function degradeReasonFor(
	failureCode: RunFailure["code"] | undefined,
	fallback: CouncilDegradedReason,
): CouncilDegradedReason {
	return failureCode === "deadline_exceeded" || failureCode === "budget_exceeded" ? failureCode : fallback
}

/**
 * Dispatches the panel's N-1 additional solvers concurrently under the shared concurrency cap,
 * alongside the lead's own artifact as panel member one. A solver that fails or returns
 * unparseable output after its one repair is dropped, not fatal. Only a whole-run deadline or
 * budget failure interrupting the dispatch degrades; every other terminal failure (in particular
 * a genuine caller abort) propagates instead of being absorbed here.
 */
async function dispatchPanel<T>(
	deps: FusionPipelineDeps,
	stageTimeoutMs: number,
	leadArtifact: T,
	panel: FusionPanel<T>,
): Promise<{ ok: true; candidates: T[] } | { ok: false; reason: CouncilDegradedReason }> {
	const assignments = buildSolverAssignments(panel.panelSize, panel.pools)
	const solved: Array<T | undefined> = Array.from({ length: assignments.length })
	if (assignments.length > 0) {
		deps.emitTransactionProgress?.("solving")
		deps.stageRuntime.startStage("solver")
		try {
			const deadline = Date.now() + deps.run.remainingMs(stageTimeoutMs)
			let next = 0
			const runSolver = async () => {
				for (;;) {
					const assignmentIndex = next++
					const assignment = assignments[assignmentIndex]
					if (!assignment) return
					try {
						const result = await panel.run(assignment, deadline)
						if (!result) deps.stageRuntime.failStage("solver", "timed_out")
						else {
							solved[assignmentIndex] = result.value
							deps.stageRuntime.completeStage("solver")
						}
					} catch (error) {
						deps.stageRuntime.rethrowTerminalFailure(error)
						if (deps.parentAborted()) throw new Error("Council request aborted")
						deps.stageRuntime.failStage("solver", safeFailureReason(error, "solver"))
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(panel.maxConcurrentCalls, assignments.length) }, runSolver))
			deps.run.throwIfAborted()
		} catch (error) {
			const failureCode = deps.terminalFailureCode(error)
			if (failureCode !== "deadline_exceeded" && failureCode !== "budget_exceeded") throw error
			debugLog(`panel interrupted by ${failureCode} with a lead artifact already produced`, error)
			deps.failActiveStages(safeFailureReason(error, "solver"))
			return { ok: false, reason: failureCode }
		}
	}
	return { ok: true, candidates: [leadArtifact, ...solved.filter((value): value is T => value !== undefined)] }
}

/**
 * Runs the fusion pipeline shared by the code and text branches: panel dispatch, the
 * `panel_unavailable` fallback, the analyst (or the fast preset's combined analyst+synthesis
 * call), and synthesis. On any stage failure, deadline, or budget exhaustion it promotes the
 * lead's own artifact instead of losing the turn — the only path that does not degrade is a
 * genuine caller abort, which propagates so the run terminates rather than applying anything
 * behind an explicit cancel.
 */
export async function runFusionPipeline<T>(
	deps: FusionPipelineDeps,
	options: FusionPipelineOptions<T>,
): Promise<FusionOutcome<T> | undefined> {
	const { stageTimeoutMs, leadArtifact, panel, comparison, promoteLeadArtifact } = options
	const degradeToLead = async (reason: CouncilDegradedReason): Promise<undefined> => {
		await promoteLeadArtifact(reason)
		return undefined
	}

	const dispatch = await dispatchPanel(deps, stageTimeoutMs, leadArtifact, panel)
	if (!dispatch.ok) return degradeToLead(dispatch.reason)

	const candidates = await comparison.usable(dispatch.candidates)
	if (candidates.length < 2) return degradeToLead("panel_unavailable")

	if (comparison.runCombined) {
		deps.emitTransactionProgress?.("comparing")
		deps.emitTransactionProgress?.("writing")
		deps.stageRuntime.startStage("combined")
		try {
			const deadline = Date.now() + deps.run.remainingMs(stageTimeoutMs)
			const result = await comparison.runCombined(candidates, deadline)
			if (!result) throw new Error("combined fusion deadline exceeded")
			deps.stageRuntime.completeStage("combined")
			return { artifact: result.value.artifact, analysis: result.value.analysis, summary: result.value.summary }
		} catch (error) {
			const failureCode = deps.terminalFailureCode(error)
			if (failureCode === "aborted") throw error
			debugLog("combined stage failed", error)
			deps.stageRuntime.failStage("combined", safeFailureReason(error, "combined"))
			return degradeToLead(degradeReasonFor(failureCode, "analyst_failed"))
		}
	}

	deps.emitTransactionProgress?.("comparing")
	deps.stageRuntime.startStage("analyst")
	let analysis: FusionAnalysis
	try {
		const deadline = Date.now() + deps.run.remainingMs(stageTimeoutMs)
		const result = await comparison.runAnalyst(candidates, deadline)
		if (!result) throw new Error("analyst deadline exceeded")
		analysis = result.value
		deps.stageRuntime.completeStage("analyst")
	} catch (error) {
		const failureCode = deps.terminalFailureCode(error)
		if (failureCode === "aborted") throw error
		debugLog("analyst stage failed", error)
		deps.stageRuntime.failStage("analyst", safeFailureReason(error, "analyst"))
		return degradeToLead(degradeReasonFor(failureCode, "analyst_failed"))
	}

	deps.emitTransactionProgress?.("writing")
	deps.stageRuntime.startStage("synthesis")
	try {
		const deadline = Date.now() + deps.run.remainingMs(stageTimeoutMs)
		const result = await comparison.runSynthesis(candidates, analysis, deadline)
		if (!result) throw new Error("synthesis deadline exceeded")
		deps.stageRuntime.completeStage("synthesis")
		return { artifact: result.value.artifact, analysis, summary: result.value.summary }
	} catch (error) {
		const failureCode = deps.terminalFailureCode(error)
		if (failureCode === "aborted") throw error
		debugLog("synthesis stage failed", error)
		deps.stageRuntime.failStage("synthesis", safeFailureReason(error, "synthesis"))
		return degradeToLead(degradeReasonFor(failureCode, "synthesis_failed"))
	}
}
