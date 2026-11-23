import type {
	AgentToolResult,
	CodemodeToolDetails,
	ExtensionContext,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent"

type CodemodeNestedCall = CodemodeToolDetails["calls"][number]

export const CODEMODE_PURPOSE_MAX_CHARS = 120

const PURPOSE_PREFIX = "// @description:"
const OPTIONS_PREFIX = "// @options:"

export interface CodemodeContextReduction {
	intermediateTextChars: number
	returnedTextChars: number
	complete: boolean
}

export type CodemodeOutcomeDetails = CodemodeToolDetails & {
	contextReduction?: CodemodeContextReduction
}

/** Read the optional purpose from its only valid positions: source line one,
 *  or immediately after @options. Invalid presentation metadata is ignored. */
export function codemodePurpose(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined
	const code = Reflect.get(args, "code")
	if (typeof code !== "string") return undefined
	const lines = code.split("\n")
	// Match execution: @options is invalid anywhere except the first line,
	// including after an otherwise-valid purpose directive.
	if (lines.some((line, index) => index > 0 && line.trimStart().startsWith(OPTIONS_PREFIX))) return undefined
	let index = 0
	if (lines[0]?.trimStart().startsWith(OPTIONS_PREFIX)) index = 1
	const line = lines[index]
	if (!line?.trimStart().startsWith(PURPOSE_PREFIX)) return undefined
	const raw = line.trimStart().slice(PURPOSE_PREFIX.length).trim()
	const purpose = raw.replace(/\s+/g, " ")
	if (!purpose || purpose.length > CODEMODE_PURPOSE_MAX_CHARS) return undefined
	return purpose
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

export function readCodemodeContextReduction(details: unknown): CodemodeContextReduction | undefined {
	if (!isRecord(details) || !isRecord(details.contextReduction)) return undefined
	const value = details.contextReduction
	if (
		!isNonNegativeSafeInteger(value.intermediateTextChars) ||
		!isNonNegativeSafeInteger(value.returnedTextChars) ||
		typeof value.complete !== "boolean"
	) {
		return undefined
	}
	// Character counters are canonical. Legacy estimatedTokensKeptOut fields
	// are ignored: the UI derives diagnostic values instead of trusting a
	// stored rounded estimate that can disagree with either count.
	return {
		intermediateTextChars: value.intermediateTextChars,
		returnedTextChars: value.returnedTextChars,
		complete: value.complete,
	}
}

export function resultTextChars(result: unknown): number {
	if (!isRecord(result) || !Array.isArray(result.content)) return 0
	// Include Pi's script header: unlike the TUI, the model still receives it,
	// so it is part of the returned context rather than free presentation text.
	let chars = 0
	for (const block of result.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") chars += block.text.length
	}
	return chars
}

function contextKey(ctx: ExtensionContext, toolCallId: string): string {
	return JSON.stringify([ctx.sessionManager.getSessionId(), toolCallId])
}

interface PendingOutcome {
	sessionId: string
	pendingNestedCalls: Set<string>
	endedNestedCalls: Set<string>
	intermediateTextChars: number
	complete: boolean
}

/** Collect numeric intermediate sizes behind the public Pi tool-event seam.
 *  Session + parent call keys isolate ACP sessions sharing one process. */
export function createCodemodeOutcomeTracker() {
	const pending = new Map<string, PendingOutcome>()
	// A direct child can itself nest. Owner links make every descendant part
	// of the same action and token-accounting tree.
	const nestedOwners = new Map<string, string>()

	const release = (key: string): void => {
		pending.delete(key)
		for (const [nestedKey, ownerKey] of nestedOwners) if (ownerKey === key) nestedOwners.delete(nestedKey)
	}
	const rootFor = (ctx: ExtensionContext, parentToolCallId: string): string | undefined => {
		const parentKey = contextKey(ctx, parentToolCallId)
		if (pending.has(parentKey)) return parentKey
		const ownerKey = nestedOwners.get(parentKey)
		return ownerKey && pending.has(ownerKey) ? ownerKey : undefined
	}

	return {
		begin(ctx: ExtensionContext, toolCallId: string): void {
			const key = contextKey(ctx, toolCallId)
			release(key)
			pending.set(key, {
				sessionId: ctx.sessionManager.getSessionId(),
				pendingNestedCalls: new Set(),
				endedNestedCalls: new Set(),
				intermediateTextChars: 0,
				complete: true,
			})
		},

		nestedStart(ctx: ExtensionContext, event: ToolExecutionStartEvent): void {
			if (!event.parentToolCallId) return
			const rootKey = rootFor(ctx, event.parentToolCallId)
			if (!rootKey) return
			pending.get(rootKey)?.pendingNestedCalls.add(event.toolCallId)
			nestedOwners.set(contextKey(ctx, event.toolCallId), rootKey)
		},

		nestedEnd(ctx: ExtensionContext, event: ToolExecutionEndEvent): void {
			nestedOwners.delete(contextKey(ctx, event.toolCallId))
			if (!event.parentToolCallId) return
			const rootKey = rootFor(ctx, event.parentToolCallId)
			if (!rootKey) return
			const outcome = pending.get(rootKey)
			if (!outcome || outcome.endedNestedCalls.has(event.toolCallId)) return
			outcome.endedNestedCalls.add(event.toolCallId)
			if (!outcome.pendingNestedCalls.delete(event.toolCallId)) outcome.complete = false
			outcome.intermediateTextChars += resultTextChars(event.result)
		},

		complete(ctx: ExtensionContext, toolCallId: string, result: AgentToolResult<unknown>): CodemodeContextReduction {
			const key = contextKey(ctx, toolCallId)
			const outcome = pending.get(key)
			release(key)
			if (!outcome) {
				const returnedTextChars = resultTextChars(result)
				return {
					intermediateTextChars: 0,
					returnedTextChars,
					complete: false,
				}
			}
			const returnedTextChars = resultTextChars(result)
			return {
				intermediateTextChars: outcome.intermediateTextChars,
				returnedTextChars,
				complete: outcome.complete && outcome.pendingNestedCalls.size === 0,
			}
		},

		discard(ctx: ExtensionContext, toolCallId?: string): void {
			if (toolCallId) {
				release(contextKey(ctx, toolCallId))
				return
			}
			const sessionId = ctx.sessionManager.getSessionId()
			for (const [key, outcome] of [...pending]) if (outcome.sessionId === sessionId) release(key)
		},
	}
}

type ActionCategory = "file" | "pattern" | "directory" | "edit" | "command" | "operation"

function actionCategory(name: string): ActionCategory {
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
		case "operation":
			return `${count} operation${plural}`
	}
}

export function codemodeActionSummary(details: unknown): string {
	if (!isRecord(details) || !Array.isArray(details.calls)) return ""
	const counts = new Map<ActionCategory, number>()
	for (const value of details.calls) {
		if (!isRecord(value) || typeof value.name !== "string") continue
		const category = actionCategory(value.name)
		counts.set(category, (counts.get(category) ?? 0) + 1)
	}
	return [...counts].map(([category, count]) => formatAction(category, count)).join(", ")
}

export function codemodeNestedCalls(details: unknown): CodemodeNestedCall[] {
	if (!isRecord(details) || !Array.isArray(details.calls)) return []
	return details.calls.filter(
		(value): value is CodemodeNestedCall =>
			isRecord(value) &&
			typeof value.name === "string" &&
			typeof value.args === "string" &&
			(value.durationMs === undefined || finiteNumber(value.durationMs)) &&
			(value.cost === undefined || finiteNumber(value.cost)) &&
			(value.error === undefined || typeof value.error === "string") &&
			(value.status === "running" || value.status === "ok" || value.status === "error" || value.status === "cancelled"),
	)
}

export function estimatedTokens(chars: number): number {
	return Math.round(chars / 4)
}

export function formatEstimatedTokenCount(tokens: number): string {
	const absolute = Math.abs(tokens)
	if (absolute < 1_000) return String(tokens)
	if (absolute < 999_500) {
		const value = tokens / 1_000
		return `${value.toFixed(Math.abs(value) < 100 ? 1 : 0).replace(/\.0$/, "")}k`
	}
	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
}
