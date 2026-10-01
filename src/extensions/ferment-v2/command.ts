import { formatCount } from "../format.js"
import { FERMENT_V2_COMMAND_NAME } from "./constants.js"
import { deriveFermentV2Name } from "./name.js"
import type { SessionFermentV2 } from "./types.js"

export type FermentV2Command =
	| { action: "show" }
	| { action: "set"; objective: string; tokenBudget?: number }
	| { action: "edit"; objective?: string }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "clear" }

export const FERMENT_V2_COMMAND_COMPLETIONS = ["edit", "pause", "resume", "clear"] as const

export function formatFermentV2Status(fermentV2: SessionFermentV2 | undefined, evaluating = false): string | undefined {
	if (!fermentV2) return undefined
	const title = deriveFermentV2Name(fermentV2.objective, fermentV2.name ?? fermentV2.presentation?.title)
	const label = fermentV2.presentation?.kind === "approved-plan" ? "Plan execution" : "Ferment V2"
	const state =
		fermentV2.status === "active" ? (evaluating ? "checking" : "running") : fermentV2.status.replace("_", " ")
	const hint = fermentV2.status === "paused" || fermentV2.status === "blocked" ? " · /ferment-v2 resume" : ""
	return `◈ ${label}: ${state} · ${title}${hint}`
}

export function parseFermentV2Command(args: string): FermentV2Command {
	const trimmed = args.trim()
	if (!trimmed) return { action: "show" }
	const [first, ...rest] = trimmed.split(/\s+/)
	const action = first.toLowerCase()
	if (action === "edit") {
		const objective = rest.join(" ").trim()
		return objective ? { action: "edit", objective } : { action: "edit" }
	}
	if (action === "pause" && rest.length === 0) return { action: "pause" }
	if (action === "resume" && rest.length === 0) return { action: "resume" }
	if (action === "clear" && rest.length === 0) return { action: "clear" }
	const parsed = parseTokenBudget(trimmed)
	return parsed.tokenBudget === undefined
		? { action: "set", objective: parsed.objective }
		: { action: "set", objective: parsed.objective, tokenBudget: parsed.tokenBudget }
}

export function formatFermentV2Summary(fermentV2: SessionFermentV2 | undefined, liveElapsedMs = 0): string {
	if (!fermentV2) return `No Ferment V2 is currently set.\nUse /${FERMENT_V2_COMMAND_NAME} <objective> to create one.`
	const evaluation = fermentV2.lastEvaluation
	const approvedPlan = fermentV2.presentation?.kind === "approved-plan" ? fermentV2.presentation : undefined
	const name = deriveFermentV2Name(fermentV2.objective, fermentV2.name ?? approvedPlan?.title)
	const title = `${approvedPlan ? "Plan execution" : "Ferment V2"}: ${name}`
	return [
		title,
		`Status: ${fermentV2.status}`,
		...(fermentV2.status === "blocked" && fermentV2.blockedReason
			? [`Blocked reason: ${fermentV2.blockedReason}`]
			: []),
		`Revision: ${fermentV2.revision}`,
		approvedPlan ? `Plan: ${approvedPlan.planPath ?? "no saved file"}` : `Objective: ${fermentV2.objective}`,
		`${approvedPlan ? "Run time" : "Fermenting time"}: ${formatFermentV2Accounting(fermentV2, liveElapsedMs)}`,
		...(fermentV2.evaluationCount === undefined ? [] : [`Evaluations: ${fermentV2.evaluationCount}`]),
		...(evaluation ? [`Last evaluation: ${evaluation.verdict} — ${evaluation.reason}`] : []),
		"",
		`Commands: ${fermentV2Commands(fermentV2)}`,
	].join("\n")
}

export function formatFermentV2Accounting(fermentV2: SessionFermentV2, liveElapsedMs = 0): string {
	return `${formatFermentV2Duration(fermentV2.timeUsedMs + liveElapsedMs)} · ${formatFermentV2Tokens(fermentV2)}`
}

export function formatFermentV2Duration(timeUsedMs: number): string {
	const totalMinutes = Math.floor(timeUsedMs / 60_000)
	if (totalMinutes < 1) return "<1m"
	if (totalMinutes < 60) return `${totalMinutes}m`
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

function fermentV2Commands(fermentV2: SessionFermentV2): string {
	if (fermentV2.status === "active") {
		return `/${FERMENT_V2_COMMAND_NAME} edit, /${FERMENT_V2_COMMAND_NAME} pause, /${FERMENT_V2_COMMAND_NAME} clear`
	}
	if (fermentV2.status === "paused" || fermentV2.status === "blocked") {
		return `/${FERMENT_V2_COMMAND_NAME} edit, /${FERMENT_V2_COMMAND_NAME} resume, /${FERMENT_V2_COMMAND_NAME} clear`
	}
	return `/${FERMENT_V2_COMMAND_NAME} <objective>, /${FERMENT_V2_COMMAND_NAME} clear`
}

function parseTokenBudget(input: string): { objective: string; tokenBudget?: number } {
	const match = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+)(?=\s|$)/i)
	if (!match) {
		if (/(?:^|\s)--tokens(?:=|\s|$)/i.test(input)) {
			throw new Error("Token budget must be a positive number, optionally suffixed with k or m.")
		}
		return { objective: input.trim() }
	}

	const raw = match[1].toLowerCase()
	const suffix = raw.at(-1)
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1
	const numeric = suffix === "m" || suffix === "k" ? raw.slice(0, -1) : raw
	const tokenBudget = Math.round(Number(numeric) * multiplier)
	if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
		throw new Error("Token budget must be a positive number, optionally suffixed with k or m.")
	}

	const start = match.index ?? 0
	return {
		objective: `${input.slice(0, start)} ${input.slice(start + match[0].length)}`.trim(),
		tokenBudget,
	}
}

function formatFermentV2Tokens(fermentV2: SessionFermentV2): string {
	const used = formatCount(fermentV2.tokensUsed)
	return fermentV2.tokenBudget === undefined ? `${used} tokens` : `${used}/${formatCount(fermentV2.tokenBudget)} tokens`
}
