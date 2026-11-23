import type { CodemodeToolDetails } from "@earendil-works/pi-coding-agent"

type CodemodeNestedCall = CodemodeToolDetails["calls"][number]

type ActionCategory = "file" | "pattern" | "directory" | "edit" | "command" | "model" | "operation"

function actionCategory(name: string): ActionCategory {
	if (name.startsWith("models.")) return "model"
	switch (name) {
		case "read":
			return "file"
		case "grep":
		case "find":
			return "pattern"
		case "ls":
			return "directory"
		case "write":
		case "edit":
		case "multiedit":
			return "edit"
		case "bash":
			return "command"
		default:
			return "operation"
	}
}

function formatAction(category: ActionCategory, count: number): string {
	const plural = count === 1 ? "" : "s"
	switch (category) {
		case "file":
			return `read ${count} file${plural}`
		case "pattern":
			return `searched for ${count} pattern${plural}`
		case "directory":
			return `listed ${count} ${count === 1 ? "directory" : "directories"}`
		case "edit":
			return `made ${count} edit${plural}`
		case "command":
			return `ran ${count} command${plural}`
		case "model":
			return `made ${count} model call${plural}`
		case "operation":
			return `${count} operation${plural}`
	}
}

function nestedCalls(details: unknown): CodemodeNestedCall[] {
	if (!details || typeof details !== "object") return []
	const calls = Reflect.get(details, "calls")
	return Array.isArray(calls) ? calls.filter((call) => typeof call?.name === "string") : []
}

/** Observed actions from Pi's `details.calls`: only calls that finished ok
 *  count as done; failed and cancelled calls are reported separately. */
export function codemodeActionSummary(details: unknown): string {
	const actions = new Map<ActionCategory, number>()
	let failed = 0
	let cancelled = 0
	for (const call of nestedCalls(details)) {
		if (call.status === "ok") {
			const category = actionCategory(call.name)
			actions.set(category, (actions.get(category) ?? 0) + 1)
		} else if (call.status === "error") failed++
		else if (call.status === "cancelled") cancelled++
	}
	const parts = [...actions].map(([category, count]) => formatAction(category, count))
	if (failed) parts.push(`${failed} failed`)
	if (cancelled) parts.push(`${cancelled} cancelled`)
	return parts.join(", ")
}

/** Pi's estimator for declaration and output budgets: characters / 4, rounded up. */
export function estimatedTokens(chars: number): number {
	return Math.ceil(chars / 4)
}

export function formatEstimatedTokenCount(tokens: number): string {
	if (tokens < 1_000) return String(tokens)
	if (tokens < 999_500) {
		const value = tokens / 1_000
		return `${value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, "")}k`
	}
	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
}
