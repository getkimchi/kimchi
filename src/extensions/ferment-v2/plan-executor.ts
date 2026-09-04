import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { FermentV2Presentation } from "./types.js"

export interface FermentV2PlanExecution {
	readonly objective: string
	readonly title: string
	readonly planText: string
	readonly planPath?: string
}

export type FermentV2PlanExecutorResult = "started" | "kept-existing"
export type FermentV2PlanExecutor = (
	execution: FermentV2PlanExecution,
	ctx: ExtensionContext,
) => Promise<FermentV2PlanExecutorResult>

const FERMENT_V2_PLAN_EXECUTOR_LOOKUP_CHANNEL = "kimchi:ferment-v2:approved-plan-executor"

interface FermentV2PlanExecutorLookup {
	resolve(executor: FermentV2PlanExecutor): void
}

export function registerFermentV2PlanExecutor(pi: ExtensionAPI, executor: FermentV2PlanExecutor): () => void {
	return pi.events.on(FERMENT_V2_PLAN_EXECUTOR_LOOKUP_CHANNEL, (data) => {
		if (isFermentV2PlanExecutorLookup(data)) data.resolve(executor)
	})
}

export function getFermentV2PlanExecutor(pi: ExtensionAPI): FermentV2PlanExecutor | undefined {
	let executor: FermentV2PlanExecutor | undefined
	const lookup: FermentV2PlanExecutorLookup = {
		resolve(candidate) {
			executor ??= candidate
		},
	}
	pi.events.emit(FERMENT_V2_PLAN_EXECUTOR_LOOKUP_CHANNEL, lookup)
	return executor
}

export function buildApprovedPlanObjective(planPath: string | undefined, planText: string): string {
	return planPath
		? `Read the approved plan at "${planPath}" before continuing.\nExecute and verify every requirement in that plan.`
		: `Execute and verify the approved plan below.\n\n${planText.trim()}`
}

function approvedPlanInstruction(presentation: FermentV2Presentation): string | undefined {
	if (presentation.planPath || presentation.planText) {
		return buildApprovedPlanObjective(presentation.planPath, presentation.planText ?? "")
	}
	return undefined
}

export function composeApprovedPlanEditObjective(objective: string, presentation?: FermentV2Presentation): string {
	const instruction = presentation?.kind === "approved-plan" ? approvedPlanInstruction(presentation) : undefined
	if (!instruction) return objective
	const trimmed = objective.trim()
	if (trimmed === instruction || trimmed.startsWith(`${instruction}\n\n`)) return trimmed
	return trimmed ? `${instruction}\n\n${trimmed}` : instruction
}

function isFermentV2PlanExecutorLookup(value: unknown): value is FermentV2PlanExecutorLookup {
	return typeof value === "object" && value !== null && "resolve" in value && typeof value.resolve === "function"
}
