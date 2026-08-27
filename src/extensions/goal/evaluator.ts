import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import { completeSimple } from "@earendil-works/pi-ai/compat"
import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { errorMessage } from "../error-message.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { getModelRoles, normalizeRoleModels, splitModelRef } from "../orchestration/model-roles.js"
import type { TodoItem } from "../todos/types.js"
import { type GoalLesson, MAX_GOAL_LESSONS } from "./lessons.js"
import { isRecord } from "./reducer.js"
import { getGoalSettings } from "./settings.js"
import type { GoalEvaluatorUsage } from "./types.js"

export const MAX_TRANSCRIPT_CHARS = 16_000
export const MAX_TODO_STATE_CHARS = 8_000
const MAX_REASON_CHARS = 1_000
/**
 * Reasoning models spend this budget on thinking before they emit an answer, so
 * a budget sized for the verdict alone returns nothing at all on those models.
 */
const REASONING_MAX_TOKENS = 4_096
const PLAIN_MAX_TOKENS = 1_024

const EVALUATOR_SYSTEM_PROMPT = `You independently decide whether a persistent coding goal should continue.

Return exactly one JSON object and no markdown:
{"verdict":"continue|met|impossible","checks":[{"requirement":"one objective requirement","met":true,"evidence":["m12"],"todoIds":[1]}],"reason":"concise evidence-based reason"}

Each observable transcript entry is prefixed with a stable ID such as [m12], and durable Goal lessons are prefixed with IDs such as [l3]. Hidden thinking is omitted; cite only IDs shown in the supplied context. Check each requirement separately and include one check per objective requirement. Include every current settled Todo ID covered by the checks. Choose met only when every check is met, cites at least one shown evidence ID, and covers every current settled Todo. A met verdict without complete, valid checks is treated as continue. Do not treat plans, claims, tool calls, file edits, or a command's exit status alone as proof that the requested behavior is correct; require the actual result or verification evidence. Missing or ambiguous evidence means continue. Choose impossible only when progress requires unavailable user input or an external state change; an unavailable preferred tool or check means continue when another approach is possible. Never call tools.`

export type GoalEvaluatorVerdict = "continue" | "met" | "impossible"

export type GoalEvaluationResult =
	| { verdict: GoalEvaluatorVerdict; reason: string; model: string; usage: GoalEvaluatorUsage }
	| { verdict: "unavailable"; reason: string; model?: string; usage?: GoalEvaluatorUsage }

interface GoalEvaluatorCheck {
	requirement: string
	met: boolean
	evidence: string[]
	todoIds: number[]
}

interface ParsedGoalEvaluatorOutput {
	verdict: GoalEvaluatorVerdict
	reason: string
	checks?: GoalEvaluatorCheck[]
}

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
	/** Bounded durable evidence restored from the Goal journal/context. */
	lessons?: readonly GoalLesson[]
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

export function parseGoalEvaluatorOutput(raw: string): ParsedGoalEvaluatorOutput | undefined {
	for (const candidate of jsonObjects(raw)) {
		const value = candidate as unknown
		if (!isRecord(value)) continue
		if (value.verdict !== "continue" && value.verdict !== "met" && value.verdict !== "impossible") continue
		if (typeof value.reason !== "string" || !value.reason.trim()) continue
		const hasChecks = Object.hasOwn(value, "checks")
		const checks = parseChecks(value.checks)
		if (hasChecks && checks === undefined) continue
		return {
			verdict: value.verdict,
			reason: value.reason.trim().slice(0, MAX_REASON_CHARS),
			...(checks ? { checks } : {}),
		}
	}
	return undefined
}

function parseChecks(value: unknown): GoalEvaluatorCheck[] | undefined {
	if (!Array.isArray(value)) return undefined
	const checks: GoalEvaluatorCheck[] = []
	for (const candidate of value) {
		if (!isRecord(candidate) || typeof candidate.requirement !== "string" || !candidate.requirement.trim())
			return undefined
		if (typeof candidate.met !== "boolean" || !Array.isArray(candidate.evidence) || !Array.isArray(candidate.todoIds))
			return undefined
		if (candidate.evidence.some((evidence) => typeof evidence !== "string" || !evidence.trim())) return undefined
		if (candidate.todoIds.some((todoId) => !Number.isSafeInteger(todoId) || todoId <= 0)) return undefined
		checks.push({
			requirement: candidate.requirement.trim(),
			met: candidate.met,
			evidence: candidate.evidence.map((evidence) => evidence.trim()),
			todoIds: candidate.todoIds,
		})
	}
	return checks
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
	const sessionModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
	let modelRef = sessionModelRef
	let deadline: AbortSignal | undefined
	let evaluationTimeoutMs: number | undefined
	try {
		const model = resolveGoalEvaluatorModel(ctx)
		if (!model) return { verdict: "unavailable", reason: "No evaluator model is available." }
		modelRef = `${model.provider}/${model.id}`
		const todoState = renderTodoState(input.todos)
		if (!todoState) {
			return {
				verdict: "unavailable",
				reason: "Current Todo state is too large for a bounded evaluation.",
				model: modelRef,
			}
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
		if (!auth.ok) return { verdict: "unavailable", reason: "Evaluator authentication is unavailable.", model: modelRef }

		const transcript = renderRecentTranscript(input.messages)
		const lessons = renderGoalLessons(input.lessons)
		const evidenceIds = new Set([...transcript.evidenceIds, ...lessons.evidenceIds])
		const context = {
			systemPrompt: EVALUATOR_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `Objective:\n${input.objective}\n\nCurrent Todo state:\n${todoState}\n\nDurable Goal lessons:\n${lessons.text || "(none)"}\n\nRecent transcript:\n${transcript.text}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		}

		// Keep the deadline separate so a timeout is distinguishable from caller cancellation.
		evaluationTimeoutMs = getGoalSettings().evaluationTimeoutMs
		deadline = AbortSignal.timeout(evaluationTimeoutMs)
		const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline
		const response = await completeSimple(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			reasoning: "minimal",
			maxTokens: model.reasoning ? REASONING_MAX_TOKENS : PLAIN_MAX_TOKENS,
			samplingParams: model.provider === "moonshotai" ? { response_format: { type: "json_object" } } : undefined,
			signal,
		})
		const usage = toGoalEvaluatorUsage(response.usage)
		const parsed = parseGoalEvaluatorOutput(contentParts(response.content))
		if (parsed) {
			const decision = { verdict: parsed.verdict, reason: parsed.reason }
			if (parsed.verdict === "met" && !isSupportedMet(parsed.checks, evidenceIds, input.todos)) {
				return {
					verdict: "continue",
					reason: "Valid completion evidence is missing; continue verification.",
					model: modelRef,
					usage,
				}
			}
			return { ...decision, model: modelRef, usage }
		}
		const reason =
			response.stopReason === "length"
				? `Evaluator ${modelRef} response was truncated before it returned a verdict.`
				: `Evaluator ${modelRef} returned no parseable verdict (${describeUnparseable(response)}).`
		return { verdict: "unavailable", reason, model: modelRef, usage }
	} catch (error) {
		return {
			verdict: "unavailable",
			reason: deadline?.aborted
				? `Evaluator ${modelRef ?? "session model"} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`
				: input.signal?.aborted
					? `Evaluator ${modelRef ?? "session model"} was cancelled.`
					: `Evaluator ${modelRef ?? "session model"} call failed: ${errorMessage(error)}`,
			...(modelRef ? { model: modelRef } : {}),
		}
	}
}

/** Bounded, privacy-safe parse diagnostics; never include evaluator reply text. */
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

function isSupportedMet(
	checks: GoalEvaluatorCheck[] | undefined,
	evidenceIds: ReadonlySet<string>,
	todos: readonly TodoItem[],
): boolean {
	if (
		checks === undefined ||
		checks.length === 0 ||
		!checks.every(
			(check) =>
				check.met &&
				check.evidence.length > 0 &&
				check.evidence.every((evidenceId) => evidenceIds.has(evidenceId)) &&
				check.todoIds.every((todoId) => todos.some((todo) => todo.id === todoId)),
		)
	)
		return false

	const coveredTodoIds = new Set(checks.flatMap((check) => check.todoIds))
	return todos
		.filter((todo) => todo.status === "completed" || todo.status === "blocked")
		.every((todo) => coveredTodoIds.has(todo.id))
}

function renderTodoState(todos: readonly TodoItem[]): string | undefined {
	const variants = [
		todos,
		todos.map(({ id, status, content, activeForm, note }) => ({
			id,
			status,
			content: content.slice(0, 200),
			...(activeForm ? { activeForm: activeForm.slice(0, 200) } : {}),
			...(note ? { note: note.slice(0, 200) } : {}),
		})),
		todos.map(({ id, status }) => ({ id, status })),
	]
	for (const variant of variants) {
		const rendered = JSON.stringify(variant)
		if (rendered.length <= MAX_TODO_STATE_CHARS) return rendered
	}
	return undefined
}

function renderGoalLessons(lessons: readonly GoalLesson[] | undefined): {
	text: string
	evidenceIds: ReadonlySet<string>
} {
	const entries = (lessons ?? []).slice(-MAX_GOAL_LESSONS).map((lesson) => {
		const id = `l${lesson.todoId}`
		return {
			id,
			text: `[${id}] [lesson todo ${lesson.todoId} ${lesson.kind}] ${lesson.text.slice(0, MAX_REASON_CHARS)}`,
		}
	})
	return {
		text: entries.map((entry) => entry.text).join("\n\n"),
		evidenceIds: new Set(entries.map((entry) => entry.id)),
	}
}

/**
 * Walks back from the newest message and stops once the budget is filled, so a
 * session holding megabytes of tool output is never materialized in full just to
 * keep its tail.
 */
function renderRecentTranscript(messages: ReadonlyArray<AgentEndEvent["messages"][number]>): {
	text: string
	evidenceIds: ReadonlySet<string>
} {
	const kept: Array<{ id: string; text: string }> = []
	let length = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const rendered = renderMessage(messages[i])
		if (!rendered) continue
		const id = `m${i + 1}`
		const text = `[${id}] ${rendered}`
		const separatorLength = kept.length > 0 ? 2 : 0
		if (length + separatorLength + text.length <= MAX_TRANSCRIPT_CHARS) {
			kept.push({ id, text })
			length += separatorLength + text.length
			continue
		}
		if (kept.length === 0) {
			const prefix = `[${id}] `
			const available = Math.max(0, MAX_TRANSCRIPT_CHARS - prefix.length)
			kept.push({ id, text: `${prefix}${rendered.slice(-available)}` })
		}
		break
	}
	const ordered = kept.reverse()
	return {
		text: ordered.map((entry) => entry.text).join("\n\n"),
		evidenceIds: new Set(ordered.map((entry) => entry.id)),
	}
}

function renderMessage(message: AgentEndEvent["messages"][number]): string {
	const record = message as unknown as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : "message"
	const toolName = typeof record.toolName === "string" ? ` ${record.toolName}` : ""
	const content = contentText(record.content)
	return content ? `[${role}${toolName}] ${content}`.trim() : ""
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			if (!isRecord(part)) return ""
			if (part.type === "thinking") return ""
			if (typeof part.text === "string") return part.text
			if (part.type === "toolCall" && typeof part.name === "string") {
				return `tool ${part.name} ${JSON.stringify(part.arguments ?? {})}`
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
}
