import type { UsageRecord } from "./usage-ledger.js"

export type MemoryUsefulnessCategory = "useful" | "redundant" | "ignored" | "contradicted" | "stale" | "unknown"

export interface UsefulnessObservation {
	factId: string
	recallId: string
	trigger: string
	kind?: string
	model?: string
	provider?: string
	workload?: string
	selected?: boolean
	conclusion?: string
	acknowledged?: boolean
	/** Advisory evidence only; never directly rewrites the truth of a fact. */
	contradicted?: boolean
	followUpSearch?: boolean
	/** Supplied only after explicit task-result verification or human review. */
	verifiedOutcome?: Exclude<MemoryUsefulnessCategory, "ignored">
}

export interface UsefulnessSummary {
	factId: string
	trigger: string
	kind: string
	model?: string
	provider?: string
	workload?: string
	selected: number
	attached: number
	steered: number
	cancelled: number
	timedOut: number
	droppedStale: number
	acknowledged: number
	followUpSearches: number
	contradictionsFlagged: number
	outcomes: Record<MemoryUsefulnessCategory, number>
	knownOutcomes: number
}

/** Attribution is per stable fact/trigger/model/workload, not per raw event.
 * The same selected and delivered observation is one recall, not two
 * independent supports. An acknowledgement never becomes a correctness vote. */
export function summarizeUsefulness(observations: readonly UsefulnessObservation[]): UsefulnessSummary[] {
	type Group = { deliveries: Map<string, UsefulnessObservation>; summary: UsefulnessSummary }
	type Delivery = { observation: UsefulnessObservation; acknowledgedEver: boolean; explicitDecline: boolean }
	const byDelivery = new Map<string, Delivery>()
	for (const next of observations) {
		if (!next.factId || !next.recallId || !next.trigger || next.selected === false) continue
		const id = `${next.recallId}\0${next.factId}`
		const prior = byDelivery.get(id)
		if (!prior) {
			byDelivery.set(id, {
				observation: { ...next },
				acknowledgedEver: next.acknowledged === true,
				explicitDecline: next.acknowledged === false,
			})
			continue
		}
		const previous = prior.observation
		const conclusion =
			previous.conclusion === "steered"
				? "steered"
				: next.conclusion === "steered"
					? "steered"
					: previous.conclusion === "attachedToTurn"
						? "attachedToTurn"
						: next.conclusion === "attachedToTurn"
							? "attachedToTurn"
							: (previous.conclusion ?? next.conclusion)
		// Post-hoc metadata is optional: retain the original recall's
		// attribution while merging its reviewed outcome and diagnostic flags.
		prior.observation = {
			...previous,
			kind: previous.kind ?? next.kind,
			model: previous.model ?? next.model,
			provider: previous.provider ?? next.provider,
			workload: previous.workload ?? next.workload,
			verifiedOutcome: next.verifiedOutcome ?? previous.verifiedOutcome,
			acknowledged: next.acknowledged ?? previous.acknowledged,
			contradicted: previous.contradicted === true || next.contradicted === true,
			followUpSearch: previous.followUpSearch === true || next.followUpSearch === true,
			conclusion,
		}
		prior.acknowledgedEver ||= next.acknowledged === true
		prior.explicitDecline ||= next.acknowledged === false
	}

	const groups = new Map<string, Group>()
	for (const delivery of byDelivery.values()) {
		const observation = delivery.observation
		const key = JSON.stringify([
			observation.factId,
			observation.trigger,
			observation.kind ?? "recall",
			observation.model,
			observation.provider,
			observation.workload,
		])
		let group = groups.get(key)
		if (!group) {
			group = {
				deliveries: new Map(),
				summary: {
					factId: observation.factId,
					trigger: observation.trigger,
					kind: observation.kind ?? "recall",
					...(observation.model ? { model: observation.model } : {}),
					...(observation.provider ? { provider: observation.provider } : {}),
					...(observation.workload ? { workload: observation.workload } : {}),
					selected: 0,
					attached: 0,
					steered: 0,
					cancelled: 0,
					timedOut: 0,
					droppedStale: 0,
					acknowledged: 0,
					followUpSearches: 0,
					contradictionsFlagged: 0,
					outcomes: { useful: 0, redundant: 0, ignored: 0, contradicted: 0, stale: 0, unknown: 0 },
					knownOutcomes: 0,
				},
			}
			groups.set(key, group)
		}
		group.deliveries.set(observation.recallId, observation)
		const summary = group.summary
		summary.selected += 1
		if (observation.conclusion === "attachedToTurn") summary.attached += 1
		if (observation.conclusion === "steered") summary.steered += 1
		if (observation.conclusion === "cancelled") summary.cancelled += 1
		if (observation.conclusion === "timed-out") summary.timedOut += 1
		if (observation.conclusion === "droppedStale") summary.droppedStale += 1
		if (delivery.acknowledgedEver) summary.acknowledged += 1
		if (observation.followUpSearch === true) summary.followUpSearches += 1
		if (observation.contradicted === true) summary.contradictionsFlagged += 1
		const category =
			observation.verifiedOutcome ??
			(delivery.explicitDecline && observation.acknowledged !== true ? "ignored" : "unknown")
		summary.outcomes[category] += 1
		if (category !== "unknown") summary.knownOutcomes += 1
	}
	return [...groups.values()].map((group) => group.summary)
}

export type MemoryRunMode = "memory-off" | "frozen-retrieval" | "capture-and-retrieval"

export interface ReplayRun {
	checkpoint: string
	workload: string
	model: string
	provider: string
	stateDigest: string
	toolSetDigest: string
	storeDigest: string
	mode: MemoryRunMode
	steps: number
	toolCalls: number
	wallMs: number
	/** Task-model tokens only; excludes memory's ledger-recorded work. */
	taskInputTokens: number
	taskOutputTokens: number
	accountingComplete: boolean
	/** Extra asynchronous capture/background work excluded from wallMs.
	 * Directly blocking retrieval is already included in the run's wallMs. */
	backgroundMs?: number
	usage?: readonly UsageRecord[]
}

export interface PairedEfficiencyReport {
	checkpoint: string
	workload: string
	model: string
	provider: string
	controlMode: MemoryRunMode
	candidateMode: MemoryRunMode
	gross: { stepsSaved: number; toolCallsSaved: number; wallMsSaved: number; modelTokensSaved: number }
	cost: { tokens: number; backgroundMs: number; failedMemoryCalls: number }
	net: { steps: number; toolCalls: number; wallMs: number; tokens: number }
	accountingComplete: boolean
}

export interface DeltaInterval {
	mean: number
	lower: number
	upper: number
}

export interface EfficiencyGroupReport {
	workload: string
	model: string
	provider: string
	controlMode: MemoryRunMode
	candidateMode: MemoryRunMode
	sampleSize: number
	accountingComplete: boolean
	net: Record<"steps" | "toolCalls" | "wallMs" | "tokens", DeltaInterval>
}

function checked(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`)
	return value
}

function totalTokens(run: ReplayRun): number {
	return checked(run.taskInputTokens, "task input tokens") + checked(run.taskOutputTokens, "task output tokens")
}

function usageCost(usage: readonly UsageRecord[] = []): { tokens: number; failedCalls: number } {
	let tokens = 0
	let failedCalls = 0
	for (const row of usage) {
		tokens +=
			checked(row.inputTokens ?? 0, "memory input tokens") + checked(row.outputTokens ?? 0, "memory output tokens")
		if (row.failed) failedCalls += 1
	}
	return { tokens, failedCalls }
}

function sameCheckpointState(control: ReplayRun, candidate: ReplayRun): void {
	if (
		!control.checkpoint ||
		control.checkpoint !== candidate.checkpoint ||
		control.workload !== candidate.workload ||
		control.model !== candidate.model ||
		control.provider !== candidate.provider ||
		control.stateDigest !== candidate.stateDigest ||
		control.toolSetDigest !== candidate.toolSetDigest ||
		control.storeDigest !== candidate.storeDigest
	) {
		throw new Error("paired replay requires the same checkpoint, model, provider, state, tools, and store")
	}
	checked(control.steps, "steps")
	checked(control.toolCalls, "tool calls")
	checked(control.wallMs, "wall time")
	checked(candidate.steps, "steps")
	checked(candidate.toolCalls, "tool calls")
	checked(candidate.wallMs, "wall time")
}

/** Net task efficiency: reduced task cost minus every measured memory cost.
 * This does not infer outcome quality from model text or clicks. */
export function pairedEfficiency(control: ReplayRun, candidate: ReplayRun): PairedEfficiencyReport {
	sameCheckpointState(control, candidate)
	const controlCost = usageCost(control.usage)
	const candidateCost = usageCost(candidate.usage)
	const cost = {
		tokens: candidateCost.tokens - controlCost.tokens,
		backgroundMs: (candidate.backgroundMs ?? 0) - (control.backgroundMs ?? 0),
		failedMemoryCalls: candidateCost.failedCalls - controlCost.failedCalls,
	}
	checked(candidateCost.tokens, "candidate memory tokens")
	checked(controlCost.tokens, "control memory tokens")
	checked(candidate.backgroundMs ?? 0, "candidate background time")
	checked(control.backgroundMs ?? 0, "control background time")
	return {
		checkpoint: control.checkpoint,
		workload: control.workload,
		model: control.model,
		provider: control.provider,
		controlMode: control.mode,
		candidateMode: candidate.mode,
		gross: {
			stepsSaved: control.steps - candidate.steps,
			toolCallsSaved: control.toolCalls - candidate.toolCalls,
			wallMsSaved: control.wallMs - candidate.wallMs,
			modelTokensSaved: totalTokens(control) - totalTokens(candidate),
		},
		cost,
		net: {
			steps: control.steps - candidate.steps,
			toolCalls: control.toolCalls - candidate.toolCalls,
			wallMs: control.wallMs - candidate.wallMs - cost.backgroundMs,
			tokens: totalTokens(control) - totalTokens(candidate) - cost.tokens,
		},
		// Explicit completeness, rather than treating absent infrastructure or
		// provider receipts as proof that they were free.
		accountingComplete: control.accountingComplete && candidate.accountingComplete,
	}
}

function quantile(sorted: readonly number[], proportion: number): number {
	if (sorted.length === 0) throw new Error("cannot summarize an empty paired replay")
	const index = (sorted.length - 1) * proportion
	const lower = Math.floor(index)
	const upper = Math.ceil(index)
	const a = sorted[lower] as number
	const b = sorted[upper] as number
	return a + (b - a) * (index - lower)
}

function interval(values: readonly number[]): DeltaInterval {
	const sorted = [...values].sort((a, b) => a - b)
	return {
		mean: values.reduce((sum, value) => sum + value, 0) / values.length,
		lower: quantile(sorted, 0.025),
		upper: quantile(sorted, 0.975),
	}
}

/** Descriptive observed-delta quantiles per model and workload, not a
 * confidence interval or a claim of statistical significance. */
export function groupedEfficiency(reports: readonly PairedEfficiencyReport[]): EfficiencyGroupReport {
	const first = reports[0]
	if (!first) throw new Error("cannot summarize empty paired replay")
	for (const report of reports.slice(1)) {
		if (
			report.workload !== first.workload ||
			report.model !== first.model ||
			report.provider !== first.provider ||
			report.controlMode !== first.controlMode ||
			report.candidateMode !== first.candidateMode
		) {
			throw new Error("grouped replay must share workload, model, provider and memory modes")
		}
	}
	return {
		workload: first.workload,
		model: first.model,
		provider: first.provider,
		controlMode: first.controlMode,
		candidateMode: first.candidateMode,
		sampleSize: reports.length,
		accountingComplete: reports.every((report) => report.accountingComplete),
		net: {
			steps: interval(reports.map((report) => report.net.steps)),
			toolCalls: interval(reports.map((report) => report.net.toolCalls)),
			wallMs: interval(reports.map((report) => report.net.wallMs)),
			tokens: interval(reports.map((report) => report.net.tokens)),
		},
	}
}
