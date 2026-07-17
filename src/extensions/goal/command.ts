import { formatCount, formatDuration } from "../format.js"
import type { SessionGoal } from "./types.js"

export type GoalCommand =
	| { action: "show" }
	| { action: "set"; objective: string; tokenBudget?: number }
	| { action: "edit"; objective?: string }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "clear" }

export const GOAL_COMMAND_COMPLETIONS = ["edit", "pause", "resume", "clear"] as const

export function parseGoalCommand(args: string): GoalCommand {
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

export function formatGoalSummary(goal: SessionGoal | undefined, liveElapsedMs = 0): string {
	if (!goal) return "No goal is currently set.\nUse /goal <objective> to create one."
	return [
		"Goal",
		`Status: ${goal.status}`,
		`Revision: ${goal.revision}`,
		`Objective: ${goal.objective}`,
		`Usage: ${formatGoalAccounting(goal, liveElapsedMs)}`,
		"",
		`Commands: ${goalCommands(goal)}`,
	].join("\n")
}

export function formatGoalAccounting(goal: SessionGoal, liveElapsedMs = 0): string {
	return `${formatDuration(goal.timeUsedMs + liveElapsedMs)} · ${formatGoalTokens(goal)}`
}

export function formatGoalStatusAccounting(goal: SessionGoal, liveElapsedMs = 0): string {
	const totalMinutes = Math.floor((goal.timeUsedMs + liveElapsedMs) / 60_000)
	const duration =
		totalMinutes < 1
			? "<1m"
			: totalMinutes < 60
				? `${totalMinutes}m`
				: `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
	return `${duration} · ${formatGoalTokens(goal)}`
}

function goalCommands(goal: SessionGoal): string {
	if (goal.status === "active") return "/goal edit, /goal pause, /goal clear"
	if (goal.status === "paused" || goal.status === "blocked") {
		return "/goal edit, /goal resume, /goal clear"
	}
	return "/goal <objective>, /goal clear"
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

function formatGoalTokens(goal: SessionGoal): string {
	const used = formatCount(goal.tokensUsed)
	return goal.tokenBudget === undefined ? `${used} tokens` : `${used}/${formatCount(goal.tokenBudget)} tokens`
}
