import { fermentLegacyNotLoadedMessage, isFermentLegacyLoadedAndEnabled } from "../ferment/resource.js"
import { FERMENT_LEGACY_COMMAND_NAME } from "../ferment/resource-id.js"
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
	| { action: "legacy-hint"; word: FermentLegacyWord; args?: string }

export const FERMENT_V2_COMMAND_COMPLETIONS = ["edit", "pause", "resume", "clear"] as const

/**
 * Subcommand words of the legacy `/ferment-legacy` parser. Before V2 took the
 * `/ferment` name these were `/ferment <word>`, so V1 users still type them.
 * `pause` and `resume` are left out because V2 handles them itself.
 * A bare word gives the hint. With text after it, only the V1 argument shapes
 * give the hint (see `matchesFermentLegacyArgs`). Any other text is an objective.
 * Keep in sync with `parseFermentCommand` in ../ferment/command-parser.ts.
 */
export const FERMENT_LEGACY_WORDS = [
	"list",
	"manual",
	"auto",
	"progress",
	"exit",
	"new",
	"switch",
	"delete",
	"abandon",
	"revise",
	"export",
	"one-shot",
] as const

export type FermentLegacyWord = (typeof FERMENT_LEGACY_WORDS)[number]

// These legacy words do nothing alone, so the hint shows the argument too.
const FERMENT_LEGACY_WORD_USAGE: Partial<Record<FermentLegacyWord, string>> = {
	switch: "switch <id-or-name>",
	delete: "delete <id-or-name>",
	revise: "revise goal|criteria|constraints",
}

function isFermentLegacyWord(word: string): word is FermentLegacyWord {
	return (FERMENT_LEGACY_WORDS as readonly string[]).includes(word)
}

const QUOTED = /^(?:"[^"]+"|'[^']+')$/
const TOKEN = /^(?!--)\S+$/
const TOKEN_OR_QUOTED = (text: string): boolean => TOKEN.test(text) || QUOTED.test(text)

/**
 * True when the text after a legacy word has the exact shape V1 accepted.
 * The shapes are narrow on purpose: `/ferment revise the README` is an
 * objective, `/ferment revise goal` is a V1 habit. A `--tokens` budget never
 * matches, so it stays a V2 run.
 */
function matchesFermentLegacyArgs(word: FermentLegacyWord, rest: string): boolean {
	switch (word) {
		case "delete":
			return TOKEN_OR_QUOTED(rest)
		case "switch": {
			const target = rest.replace(/^--force\s+/, "").replace(/\s+--force$/, "")
			return TOKEN_OR_QUOTED(target)
		}
		case "revise":
			return /^(?:goal|criteria|constraints)$/i.test(rest)
		case "new":
		case "abandon":
		case "one-shot":
			return QUOTED.test(rest)
		default:
			return false
	}
}

/**
 * Shown instead of starting a run when `/ferment <word>` is a legacy command
 * a V1 user would type: the bare word, or the word with its V1 arguments.
 * A run would start autonomous work on text that was meant as a command.
 */
export function formatFermentLegacyWordHint(word: FermentLegacyWord, args?: string): string {
	const legacyCommand = args
		? `/${FERMENT_LEGACY_COMMAND_NAME} ${word} ${args}`
		: `/${FERMENT_LEGACY_COMMAND_NAME} ${FERMENT_LEGACY_WORD_USAGE[word] ?? word}`
	const typed = args ? `${word} ${args}` : word
	return [
		`/${FERMENT_V2_COMMAND_NAME} ${typed} is a legacy Ferment command. Use ${legacyCommand}.`,
		...(isFermentLegacyLoadedAndEnabled()
			? []
			: [fermentLegacyNotLoadedMessage(`/${FERMENT_LEGACY_COMMAND_NAME} ${word}`)]),
		...(word === "exit" || word === "abandon"
			? [`To stop the current Ferment, use /${FERMENT_V2_COMMAND_NAME} pause or /${FERMENT_V2_COMMAND_NAME} clear.`]
			: []),
		args
			? "To start a Ferment with this as the objective, rephrase it as a sentence."
			: `To start a Ferment with "${word}" as the objective, write a longer objective.`,
	].join("\n")
}

export function formatFermentV2Status(fermentV2: SessionFermentV2 | undefined, evaluating = false): string | undefined {
	if (!fermentV2) return undefined
	const title = deriveFermentV2Name(fermentV2.objective, fermentV2.name ?? fermentV2.presentation?.title)
	const label = fermentV2.presentation?.kind === "approved-plan" ? "Plan execution" : "Ferment"
	const state =
		fermentV2.status === "active" ? (evaluating ? "checking" : "running") : fermentV2.status.replace("_", " ")
	const hint =
		fermentV2.status === "paused" || fermentV2.status === "blocked" ? ` · /${FERMENT_V2_COMMAND_NAME} resume` : ""
	return `◈ ${label}: ${state} · ${title}${hint}`
}

/**
 * Status line while the executing verifier runs: model, elapsed time, and the
 * warning that concurrent user edits may be reverted by the integrity guard.
 */
export function formatFermentV2VerifyingStatus(model: string | undefined, elapsedMs: number): string {
	return `◈ Ferment: verifying · ${model ?? "…"} · ${formatDuration(Math.max(0, elapsedMs))} · file edits may be reverted`
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
	if (isFermentLegacyWord(action)) {
		if (rest.length === 0) return { action: "legacy-hint", word: action }
		const args = trimmed.slice(first.length).trim()
		if (matchesFermentLegacyArgs(action, args)) return { action: "legacy-hint", word: action, args }
	}
	const parsed = parseTokenBudget(trimmed)
	return parsed.tokenBudget === undefined
		? { action: "set", objective: parsed.objective }
		: { action: "set", objective: parsed.objective, tokenBudget: parsed.tokenBudget }
}

export function formatFermentV2Summary(fermentV2: SessionFermentV2 | undefined, liveElapsedMs = 0): string {
	if (!fermentV2) return `No Ferment is currently set.\nUse /${FERMENT_V2_COMMAND_NAME} <objective> to create one.`
	const evaluation = fermentV2.lastEvaluation
	const approvedPlan = fermentV2.presentation?.kind === "approved-plan" ? fermentV2.presentation : undefined
	const name = deriveFermentV2Name(fermentV2.objective, fermentV2.name ?? approvedPlan?.title)
	const title = `${approvedPlan ? "Plan execution" : "Ferment"}: ${name}`
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
