import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

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

const APPROVED_PLAN_INSTRUCTIONS =
	"Implement the approved plan below, complete its requirements, and verify the result. " +
	"This approved Markdown is authoritative even if the saved copy changes or is missing."
const SAVED_PLAN_REFERENCE = "\n\nSaved plan copy (reference only): "
const APPROVED_PLAN_OPEN = "\n\n<approved_plan>\n"
const APPROVED_PLAN_CLOSE = "\n</approved_plan>"

export function buildApprovedPlanObjective(planPath: string | undefined, planText: string): string {
	const reference = planPath ? `${SAVED_PLAN_REFERENCE}${JSON.stringify(planPath)}` : ""
	return `${APPROVED_PLAN_INSTRUCTIONS}${reference}${APPROVED_PLAN_OPEN}${planText}${APPROVED_PLAN_CLOSE}`
}

/** Recognize an older explicitly edited snapshot after presentation metadata was dropped. */
export function isApprovedPlanObjective(objective: string): boolean {
	if (!objective.startsWith(APPROVED_PLAN_INSTRUCTIONS)) return false
	const remainder = objective.slice(APPROVED_PLAN_INSTRUCTIONS.length)
	const opening = remainder.indexOf(APPROVED_PLAN_OPEN)
	if (opening < 0 || !remainder.slice(opening + APPROVED_PLAN_OPEN.length).includes(APPROVED_PLAN_CLOSE)) return false
	const reference = remainder.slice(0, opening)
	if (!reference) return true
	if (!reference.startsWith(SAVED_PLAN_REFERENCE)) return false
	try {
		const path: unknown = JSON.parse(reference.slice(SAVED_PLAN_REFERENCE.length))
		return typeof path === "string" && path.length > 0 && reference === `${SAVED_PLAN_REFERENCE}${JSON.stringify(path)}`
	} catch {
		return false
	}
}

function isFermentV2PlanExecutorLookup(value: unknown): value is FermentV2PlanExecutorLookup {
	return typeof value === "object" && value !== null && "resolve" in value && typeof value.resolve === "function"
}
