import type { AgentToolResult, CodemodeToolDetails } from "@earendil-works/pi-coding-agent"

/** One display line: purposes and failure reasons are cut to this many characters. */
export const DISPLAY_LINE_MAX_CHARS = 120

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

/** What makes two successful calls the same action: the file for reads,
 *  the arguments for searches and listings. Edits, commands and model calls
 *  each count, even when repeated. */
function distinctKey(category: ActionCategory, call: CodemodeNestedCall): string | undefined {
	switch (category) {
		case "file":
			return readPath(call.args) ?? call.args
		case "pattern":
		case "directory":
			return call.args
		default:
			return undefined
	}
}

/** Pi stores nested args as a JSON preview that may be cut at 200 characters. */
function readPath(args: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(args)
		const path = parsed && typeof parsed === "object" ? Reflect.get(parsed, "path") : undefined
		return typeof path === "string" ? path : undefined
	} catch {
		return undefined
	}
}

/** Other tools (MCP, extensions) are named when they are all the same tool. */
function formatOperations(calls: CodemodeNestedCall[]): string {
	const names = new Set(calls.map((call) => call.name))
	if (names.size > 1) return formatAction("operation", calls.length)
	const [name] = names
	return calls.length === 1 ? `called ${name}` : `called ${name} ×${calls.length}`
}

/** Observed actions from Pi's `details.calls`: only calls that finished ok
 *  count as done; failed and cancelled calls are reported separately. */
export function codemodeActionSummary(details: unknown): string {
	const actions = new Map<ActionCategory, CodemodeNestedCall[]>()
	let failed = 0
	let cancelled = 0
	for (const call of nestedCalls(details)) {
		if (call.status === "ok") {
			const category = actionCategory(call.name)
			actions.set(category, [...(actions.get(category) ?? []), call])
		} else if (call.status === "error") failed++
		else if (call.status === "cancelled") cancelled++
	}
	const parts = [...actions].map(([category, calls]) => {
		if (category === "operation") return formatOperations(calls)
		const keys = calls.map((call) => distinctKey(category, call))
		const count = keys.every((key) => key !== undefined) ? new Set(keys).size : calls.length
		return formatAction(category, count)
	})
	if (failed) parts.push(`${failed} failed`)
	if (cancelled) parts.push(`${cancelled} cancelled`)
	return parts.join(", ")
}

/** Cut to `max` code points, ending with an ellipsis, so emoji are never split. */
export function truncateForDisplay(text: string, max: number): string {
	const codePoints = [...text]
	if (codePoints.length <= max) return text
	return `${codePoints.slice(0, max - 1).join("")}…`
}

const SCRIPT_ERROR_MARKER = "Script error:"
/** Pi's result header lines, which say nothing about why the script failed. */
const RESULT_HEADER = /^(Script failed|Script completed|Wall time .*|Output:)$/

/** Why a failed script failed, on one line: the first line of Pi's
 *  `Script error:` block, or of an error thrown before the script ran
 *  (invalid `@options`, a syntax error). */
export function codemodeFailureReason(result: AgentToolResult<unknown>): string | undefined {
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
	const errorAt = text.indexOf(SCRIPT_ERROR_MARKER)
	const lines = (errorAt >= 0 ? text.slice(errorAt + SCRIPT_ERROR_MARKER.length) : text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	const reason = lines[0]
	// Pi's header with no error block: the reason is not in the result.
	if (!reason || (errorAt < 0 && RESULT_HEADER.test(reason))) return undefined
	return truncateForDisplay(reason, DISPLAY_LINE_MAX_CHARS)
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
