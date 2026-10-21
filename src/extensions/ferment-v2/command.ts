import { formatCount, formatDuration } from "../format.js"
import { FERMENT_V2_COMMAND_NAME } from "./constants.js"
import { deriveFermentV2Name } from "./name.js"
import type { FermentV2Evaluation, SessionFermentV2 } from "./types.js"

export type FermentV2Command =
	| { action: "show" }
	| { action: "set"; objective: string; tokenBudget?: number }
	| { action: "edit"; objective?: string }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "clear" }
	| { action: "verify"; objectiveFile: string; out: string; baseline?: string }

/** Visible completions; the headless `--verify` entry is deliberately not listed. */
export const FERMENT_V2_COMMAND_COMPLETIONS = ["edit", "pause", "resume", "clear"] as const

const VERIFY_USAGE = `Usage: /${FERMENT_V2_COMMAND_NAME} --verify --objective-file <path> [--baseline <rev>] --out <path>`
const VERIFY_FLAGS = ["objective-file", "out", "baseline"] as const

export function formatFermentV2Status(fermentV2: SessionFermentV2 | undefined, evaluating = false): string | undefined {
	if (!fermentV2) return undefined
	const title = deriveFermentV2Name(fermentV2.objective, fermentV2.name ?? fermentV2.presentation?.title)
	const label = fermentV2.presentation?.kind === "approved-plan" ? "Plan execution" : "Ferment V2"
	const state =
		fermentV2.status === "active" ? (evaluating ? "checking" : "running") : fermentV2.status.replace("_", " ")
	const hint = fermentV2.status === "paused" || fermentV2.status === "blocked" ? " · /ferment-v2 resume" : ""
	return `◈ ${label}: ${state} · ${title}${hint}`
}

/**
 * Status line while the executing verifier runs: model, elapsed time, and the
 * warning that concurrent user edits may be reverted by the integrity guard.
 */
export function formatFermentV2VerifyingStatus(model: string | undefined, elapsedMs: number): string {
	return `◈ Ferment V2: verifying · ${model ?? "…"} · ${formatDuration(Math.max(0, elapsedMs))} · file edits may be reverted`
}

export function parseFermentV2Command(args: string): FermentV2Command {
	const trimmed = args.trim()
	if (!trimmed) return { action: "show" }
	// Only a leading `--verify` flag selects the headless entry, so an objective
	// such as "verify the login flow" stays an objective.
	if (/^--verify(?:\s|$)/i.test(trimmed)) return parseVerifyCommand(trimmed.slice("--verify".length))
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
		...(fermentV2.verifierUsage
			? [
					`Verifier: ${fermentV2.verifierUsage.runs} run${fermentV2.verifierUsage.runs === 1 ? "" : "s"} · ${formatCount(fermentV2.verifierUsage.totalTokens)} tokens · $${fermentV2.verifierUsage.costUsd.toFixed(2)}`,
				]
			: []),
		...(evaluation
			? [`Last evaluation: ${evaluation.verdict} — ${evaluation.reason}${formatFermentV2EvaluatorModel(evaluation)}`]
			: []),
		"",
		`Commands: ${fermentV2Commands(fermentV2)}`,
	].join("\n")
}

function formatFermentV2EvaluatorModel(evaluation: FermentV2Evaluation): string {
	if (!evaluation.model) return ""
	return ` (evaluator: ${evaluation.model}${evaluation.sameModelAsImplementer ? ", same as implementer" : ""})`
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

/**
 * Split arguments on whitespace, shell-style: a token is a run of unquoted
 * and single- or double-quoted segments (`--out="a b.json"`, `"a b".json`),
 * with the quotes removed — so paths with spaces can be passed.
 */
function tokenizeArguments(input: string): string[] {
	const tokens: string[] = []
	for (const match of input.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) {
		tokens.push(
			match[0].replace(/"([^"]*)"|'([^']*)'/g, (_quoted, double: string | undefined, single: string | undefined) => {
				return double ?? single ?? ""
			}),
		)
	}
	return tokens
}

function parseVerifyCommand(input: string): FermentV2Command {
	const values: Partial<Record<(typeof VERIFY_FLAGS)[number], string>> = {}
	const tokens = tokenizeArguments(input)
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token)
		const name = VERIFY_FLAGS.find((flag) => flag === match?.[1])
		if (!match || !name) throw new Error(`Unknown --verify argument "${token}". ${VERIFY_USAGE}`)
		const value = match[2] ?? tokens[++i]
		if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value. ${VERIFY_USAGE}`)
		if (values[name] !== undefined) throw new Error(`--${name} was given more than once. ${VERIFY_USAGE}`)
		values[name] = value
	}
	const objectiveFile = values["objective-file"]
	if (!objectiveFile) throw new Error(`--objective-file is required. ${VERIFY_USAGE}`)
	if (!values.out) throw new Error(`--out is required. ${VERIFY_USAGE}`)
	return {
		action: "verify",
		objectiveFile,
		out: values.out,
		...(values.baseline ? { baseline: values.baseline } : {}),
	}
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
