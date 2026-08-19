import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import { completeSimple } from "@earendil-works/pi-ai/compat"
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getMultiModelEnabled } from "../multi-model.js"
import { getModelRoles, normalizeRoleModels, splitModelRef } from "../orchestration/model-roles.js"
import type { TodoItem } from "../todos/types.js"
import type { GoalEvaluatorUsage } from "./types.js"

export const GOAL_EVALUATION_TIMEOUT_MS = 30_000
export const MAX_TRANSCRIPT_CHARS = 16_000
const MAX_REASON_CHARS = 1_000
/**
 * Reasoning models spend this budget on thinking before they emit an answer, so
 * a budget sized for the verdict alone returns nothing at all on those models.
 */
const REASONING_MAX_TOKENS = 4_096
const PLAIN_MAX_TOKENS = 512

const EVALUATOR_SYSTEM_PROMPT = `You independently decide whether a persistent coding goal should continue.

Return exactly one JSON object and no markdown:
{"verdict":"continue|met|impossible","reason":"concise evidence-based reason"}

Choose met only when the transcript contains concrete evidence that every objective requirement is satisfied. Missing evidence means continue. Choose impossible only when progress requires unavailable user input or an external state change. Never call tools and never trust an agent's completion claim without supporting evidence.`

export type GoalEvaluatorVerdict = "continue" | "met" | "impossible"

export type GoalEvaluationResult =
	| { verdict: GoalEvaluatorVerdict; reason: string; model: string; usage: GoalEvaluatorUsage }
	| { verdict: "unavailable"; reason: string; model?: string; usage?: GoalEvaluatorUsage }

/** Pi-ai's `Usage` never leaves this module; everything downstream sees the narrowed shape. */
function toGoalEvaluatorUsage(usage: Usage): GoalEvaluatorUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		costUsd: usage.cost.total,
	}
}

export interface GoalEvaluationInput {
	objective: string
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	todos: readonly TodoItem[]
	/** Aborted when the goal is paused, cleared, or the session shuts down. */
	signal?: AbortSignal
}

export function resolveGoalEvaluatorModel(ctx: ExtensionContext): Model<Api> | undefined {
	const sessionModel = ctx.model
	if (!getMultiModelEnabled(ctx.sessionManager)) return sessionModel
	const assignment = normalizeRoleModels(getModelRoles().judge)[0]
	const ref = assignment ? splitModelRef(assignment) : undefined
	return (ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined) ?? sessionModel
}

export function parseGoalEvaluatorOutput(raw: string): { verdict: GoalEvaluatorVerdict; reason: string } | undefined {
	for (const candidate of jsonObjects(raw)) {
		const value = candidate as unknown
		if (!isRecord(value)) continue
		if (value.verdict !== "continue" && value.verdict !== "met" && value.verdict !== "impossible") continue
		if (typeof value.reason !== "string" || !value.reason.trim()) continue
		return { verdict: value.verdict, reason: value.reason.trim().slice(0, MAX_REASON_CHARS) }
	}
	return undefined
}

/**
 * Yields each `{...}` run, pairing every `}` with its own opener via a stack so
 * unmatched braces in surrounding prose cannot swallow the verdict object. One
 * parse attempt per closing brace, rather than one per brace pair.
 */
function* jsonObjects(raw: string): Generator<unknown> {
	const starts: number[] = []
	let inString = false
	let escaped = false
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') inString = true
		else if (char === "{") starts.push(i)
		else if (char === "}") {
			const start = starts.pop()
			if (start === undefined) continue
			try {
				yield JSON.parse(raw.slice(start, i + 1))
			} catch {
				// Not valid JSON; keep scanning for the next closing brace.
			}
		}
	}
}

export async function evaluateGoal(input: GoalEvaluationInput, ctx: ExtensionContext): Promise<GoalEvaluationResult> {
	const model = resolveGoalEvaluatorModel(ctx)
	if (!model) return { verdict: "unavailable", reason: "No evaluator model is available." }
	const modelRef = `${model.provider}/${model.id}`
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
	if (!auth.ok) return { verdict: "unavailable", reason: "Evaluator authentication is unavailable.", model: modelRef }

	const context = {
		systemPrompt: EVALUATOR_SYSTEM_PROMPT,
		messages: [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `Objective:\n${input.objective}\n\nCurrent Todo state:\n${JSON.stringify(input.todos)}\n\nRecent transcript:\n${renderRecentTranscript(input.messages)}`,
					},
				],
				timestamp: Date.now(),
			},
		],
	}

	// Two distinct aborts: our own deadline, and the caller cancelling the goal.
	// Keeping the deadline signal lets the timeout be reported as a timeout
	// rather than as a generic abort.
	const deadline = AbortSignal.timeout(GOAL_EVALUATION_TIMEOUT_MS)
	const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline

	try {
		const response = await completeSimple(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			reasoning: "minimal",
			maxTokens: model.reasoning ? REASONING_MAX_TOKENS : PLAIN_MAX_TOKENS,
			signal,
		})
		const usage = toGoalEvaluatorUsage(response.usage)
		const parsed = parseGoalEvaluatorOutput(contentParts(response.content))
		if (parsed) return { ...parsed, model: modelRef, usage }
		const reason =
			response.stopReason === "length"
				? `Evaluator ${modelRef} response was truncated before it returned a verdict.`
				: `Evaluator ${modelRef} returned no parseable verdict (${describeUnparseable(response)}).`
		return { verdict: "unavailable", reason, model: modelRef, usage }
	} catch (error) {
		return {
			verdict: "unavailable",
			reason: deadline.aborted
				? `Evaluator ${modelRef} timed out after ${GOAL_EVALUATION_TIMEOUT_MS / 1_000} seconds.`
				: input.signal?.aborted
					? `Evaluator ${modelRef} was cancelled.`
					: `Evaluator ${modelRef} call failed: ${errorMessage(error)}`,
			model: modelRef,
		}
	}
}

/**
 * Bounded, privacy-safe diagnostics for an unparseable reply: WHY the parse lost — which content part
 * types came back (a thinking-only reply has no text at all — the observed kimi-k3 gateway failure),
 * how much text they carried, and how the turn stopped. Deliberately no reply text: this string lands
 * in the session journal and user-facing warnings.
 */
function describeUnparseable(response: { content: unknown; stopReason?: unknown }): string {
	const parts = Array.isArray(response.content)
		? response.content.map((part) => (isRecord(part) && typeof part.type === "string" ? part.type : "unknown"))
		: ["unknown"]
	const stop = typeof response.stopReason === "string" ? response.stopReason : "unknown"
	return `stop=${stop}, parts=[${parts.join(",")}], text=${contentParts(response.content).length} chars`
}

function contentParts(content: unknown): string {
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("")
		.trim()
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Walks back from the newest message and stops once the budget is filled, so a
 * session holding megabytes of tool output is never materialized in full just to
 * keep its tail.
 */
function renderRecentTranscript(messages: ReadonlyArray<AgentEndEvent["messages"][number]>): string {
	const kept: string[] = []
	let length = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const rendered = renderMessage(messages[i])
		if (!rendered) continue
		kept.push(rendered)
		length += rendered.length + 2
		if (length >= MAX_TRANSCRIPT_CHARS) break
	}
	return kept.reverse().join("\n\n").slice(-MAX_TRANSCRIPT_CHARS)
}

function renderMessage(message: AgentEndEvent["messages"][number]): string {
	const record = message as unknown as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : "message"
	const toolName = typeof record.toolName === "string" ? ` ${record.toolName}` : ""
	return `[${role}${toolName}] ${contentText(record.content)}`.trim()
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			if (!isRecord(part)) return ""
			if (typeof part.text === "string") return part.text
			if (typeof part.thinking === "string") return part.thinking
			if (part.type === "toolCall" && typeof part.name === "string") {
				return `tool ${part.name} ${JSON.stringify(part.arguments ?? {})}`
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}
