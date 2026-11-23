import type {
	AgentToolResult,
	ExtensionContext,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent"

export interface CodemodeContextReduction {
	intermediateTextChars: number
	returnedTextChars: number
	/** False when some data the script received was not counted. */
	complete: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
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
	return {
		intermediateTextChars: value.intermediateTextChars,
		returnedTextChars: value.returnedTextChars,
		complete: value.complete,
	}
}

interface TextSize {
	chars: number
	/** True when the result also carried blocks (images) this count cannot size. */
	hasNonText: boolean
}

function resultTextSize(result: unknown): TextSize {
	const size = { chars: 0, hasNonText: false }
	if (!isRecord(result) || !Array.isArray(result.content)) return size
	// Include Pi's script header: unlike the TUI, the model still receives it,
	// so it is part of the returned context rather than free presentation text.
	for (const block of result.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") size.chars += block.text.length
		else size.hasNonText = true
	}
	return size
}

/** `models.*` results reach the script without tool execution events, so they are never counted. */
function hasModelCalls(details: unknown): boolean {
	return (
		isRecord(details) &&
		Array.isArray(details.calls) &&
		details.calls.some((call) => isRecord(call) && typeof call.name === "string" && call.name.startsWith("models."))
	)
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

/** Collect the sizes of results a Codemode script received directly, behind
 *  the public Pi tool-event seam. Session + parent call keys isolate ACP
 *  sessions sharing one process. */
export function createCodemodeOutcomeTracker() {
	const pending = new Map<string, PendingOutcome>()

	return {
		begin(ctx: ExtensionContext, toolCallId: string): void {
			pending.set(contextKey(ctx, toolCallId), {
				sessionId: ctx.sessionManager.getSessionId(),
				pendingNestedCalls: new Set(),
				endedNestedCalls: new Set(),
				intermediateTextChars: 0,
				complete: true,
			})
		},

		nestedStart(ctx: ExtensionContext, event: ToolExecutionStartEvent): void {
			if (!event.parentToolCallId) return
			pending.get(contextKey(ctx, event.parentToolCallId))?.pendingNestedCalls.add(event.toolCallId)
		},

		nestedEnd(ctx: ExtensionContext, event: ToolExecutionEndEvent): void {
			if (!event.parentToolCallId) return
			// Only direct children: a grandchild's result reaches its own parent
			// tool, not the script, so counting it would double count.
			const outcome = pending.get(contextKey(ctx, event.parentToolCallId))
			if (!outcome || outcome.endedNestedCalls.has(event.toolCallId)) return
			outcome.endedNestedCalls.add(event.toolCallId)
			if (!outcome.pendingNestedCalls.delete(event.toolCallId)) outcome.complete = false
			const size = resultTextSize(event.result)
			outcome.intermediateTextChars += size.chars
			if (size.hasNonText) outcome.complete = false
		},

		complete(ctx: ExtensionContext, toolCallId: string, result: AgentToolResult<unknown>): CodemodeContextReduction {
			const key = contextKey(ctx, toolCallId)
			const outcome = pending.get(key)
			pending.delete(key)
			const returned = resultTextSize(result)
			const returnedTextChars = returned.chars
			if (!outcome) return { intermediateTextChars: 0, returnedTextChars, complete: false }
			return {
				intermediateTextChars: outcome.intermediateTextChars,
				returnedTextChars,
				complete:
					outcome.complete &&
					outcome.pendingNestedCalls.size === 0 &&
					!returned.hasNonText &&
					!hasModelCalls(result.details),
			}
		},

		discard(ctx: ExtensionContext, toolCallId?: string): void {
			if (toolCallId) {
				pending.delete(contextKey(ctx, toolCallId))
				return
			}
			const sessionId = ctx.sessionManager.getSessionId()
			for (const [key, outcome] of pending) if (outcome.sessionId === sessionId) pending.delete(key)
		},
	}
}
