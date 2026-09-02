import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import { completeSimple } from "@earendil-works/pi-ai/compat"
import { type AgentEndEvent, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { getMultiModelEnabled } from "../multi-model.js"
import { getModelRoles, normalizeRoleModels, splitModelRef } from "../orchestration/model-roles.js"
import type { TodoItem } from "../todos/types.js"
import { type FermentV2Lesson, MAX_FERMENT_V2_LESSON_CHARS, MAX_FERMENT_V2_LESSONS } from "./lessons.js"
import { isRecord } from "./reducer.js"
import { getFermentV2Settings } from "./settings.js"
import type { FermentV2EvaluatorUsage } from "./types.js"

export const MAX_TRANSCRIPT_CHARS = 16_000
export const MAX_TODO_STATE_CHARS = 8_000
const MAX_REASON_CHARS = 1_000

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
/**
 * Reasoning models spend this budget on thinking before they emit an answer, so
 * a budget sized for the verdict alone returns nothing at all on those models.
 */
const REASONING_MAX_TOKENS = 4_096
const PLAIN_MAX_TOKENS = 1_024

const EVALUATOR_SYSTEM_PROMPT = `<ferment_v2_evaluator>
You independently decide whether a persistent coding Ferment V2 should continue.

<output_contract>
- Return exactly one JSON object and no markdown:
{"verdict":"continue|met|impossible","checks":[{"requirement":"one objective requirement","met":true,"failureMode":"plausible way this could still be wrong, and why the cited evidence rules it out","evidence":["m12"],"todoIds":[1]}],"reason":"concise evidence-based reason"}
</output_contract>

<evidence_policy>
- Observable transcript entries have IDs such as [m12]. Durable Ferment V2 lessons have IDs such as [l3]. Cite only shown IDs.
- Only tool results and lessons labelled evidence can support met. User or assistant claims, plans, tool calls, file edits, decision or dead-end lessons, and command exit status alone are not proof.
- Judge evidence against the objective's full scope and likely failure modes, not only supplied examples or self-selected checks.
</evidence_policy>

<completion_checks>
- Check each requirement separately.
- Include every settled Todo ID covered by the checks.
- Every met check needs a concrete failureMode that the cited evidence challenges.
- Every met check needs retained evidence. Partial, missing, or ambiguous evidence means continue.
</completion_checks>

<verdict_policy>
- met: every requirement is met and every settled Todo is covered.
- continue: work can still progress. Name the first unmet requirement and its exact missing or weak evidence.
- impossible: progress requires unavailable user input or an external state change. A missing preferred tool or check is not enough when another approach exists.
</verdict_policy>

Never call tools.
</ferment_v2_evaluator>`

export type FermentV2EvaluatorVerdict = "continue" | "met" | "impossible"

export type FermentV2EvaluationResult =
	| { verdict: FermentV2EvaluatorVerdict; reason: string; model: string; usage: FermentV2EvaluatorUsage }
	| { verdict: "unavailable"; reason: string; model?: string; usage?: FermentV2EvaluatorUsage }

interface FermentV2EvaluatorCheck {
	requirement: string
	met: boolean
	failureMode?: string
	evidence: string[]
	todoIds: number[]
}

interface ParsedFermentV2EvaluatorOutput {
	verdict: FermentV2EvaluatorVerdict
	reason: string
	checks?: FermentV2EvaluatorCheck[]
}

function toFermentV2EvaluatorUsage(usage: Usage): FermentV2EvaluatorUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		costUsd: usage.cost.total,
	}
}

export interface FermentV2EvaluationInput {
	objective: string
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	todos: readonly TodoItem[]
	lessons?: readonly FermentV2Lesson[]
	signal?: AbortSignal
}

type RenderedTranscriptEntry = {
	index: number
	id: string
	prefix: string
	content: string
	evidence: boolean
}

export function resolveFermentV2EvaluatorModel(ctx: ExtensionContext): Model<Api> | undefined {
	const sessionModel = ctx.model
	if (!getMultiModelEnabled(ctx.sessionManager)) return sessionModel
	const assignment = normalizeRoleModels(getModelRoles().judge)[0]
	const ref = assignment ? splitModelRef(assignment) : undefined
	return (ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined) ?? sessionModel
}

export function parseFermentV2EvaluatorOutput(raw: string): ParsedFermentV2EvaluatorOutput | undefined {
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

function parseChecks(value: unknown): FermentV2EvaluatorCheck[] | undefined {
	if (!Array.isArray(value)) return undefined
	const checks: FermentV2EvaluatorCheck[] = []
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
			...(typeof candidate.failureMode === "string" && candidate.failureMode.trim()
				? { failureMode: candidate.failureMode.trim() }
				: {}),
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
			} catch {}
		}
	}
}

export async function evaluateFermentV2(
	input: FermentV2EvaluationInput,
	ctx: ExtensionContext,
): Promise<FermentV2EvaluationResult> {
	const sessionModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
	let modelRef = sessionModelRef
	let deadline: AbortSignal | undefined
	let evaluationTimeoutMs: number | undefined
	try {
		const model = resolveFermentV2EvaluatorModel(ctx)
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
		const lessons = renderFermentV2Lessons(input.lessons)
		const evidenceIds = new Set([...transcript.evidenceIds, ...lessons.evidenceIds])
		const context = {
			systemPrompt: EVALUATOR_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `Objective:\n${input.objective}\n\nCurrent Todo state:\n${todoState}\n\nDurable Ferment V2 lessons:\n${lessons.text || "(none)"}\n\nRecent transcript:\n${transcript.text}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		}
		const evaluatorSession = createEvaluatorSession(ctx)
		evaluatorSession.appendSessionInfo("Ferment V2 evaluator")
		evaluatorSession.appendModelChange(model.provider, model.id)
		evaluatorSession.appendMessage(context.messages[0])

		// Keep the deadline separate so a timeout is distinguishable from caller cancellation.
		evaluationTimeoutMs = getFermentV2Settings().evaluationTimeoutMs
		deadline = AbortSignal.timeout(evaluationTimeoutMs)
		const signal = input.signal ? AbortSignal.any([deadline, input.signal]) : deadline
		const request = () =>
			completeSimple(model, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				reasoning: "minimal",
				maxTokens: model.reasoning ? REASONING_MAX_TOKENS : PLAIN_MAX_TOKENS,
				samplingParams: model.provider === "moonshotai" ? { response_format: { type: "json_object" } } : undefined,
				signal,
			})
		let response = await request()
		evaluatorSession.appendMessage(response)
		let usage = toFermentV2EvaluatorUsage(response.usage)
		if (
			response.stopReason === "aborted" &&
			!signal.aborted &&
			!parseFermentV2EvaluatorOutput(contentParts(response.content))
		) {
			response = await request()
			evaluatorSession.appendMessage(response)
			const retriedUsage = toFermentV2EvaluatorUsage(response.usage)
			usage = {
				input: usage.input + retriedUsage.input,
				output: usage.output + retriedUsage.output,
				cacheRead: usage.cacheRead + retriedUsage.cacheRead,
				cacheWrite: usage.cacheWrite + retriedUsage.cacheWrite,
				totalTokens: usage.totalTokens + retriedUsage.totalTokens,
				costUsd: usage.costUsd + retriedUsage.costUsd,
			}
		}
		if (signal.aborted) throw signal.reason
		const parsed = parseFermentV2EvaluatorOutput(contentParts(response.content))
		if (parsed) {
			const decision = { verdict: parsed.verdict, reason: parsed.reason }
			const unsupportedReason =
				parsed.verdict === "met" ? unsupportedMetReason(parsed.checks, evidenceIds, input.todos) : undefined
			if (unsupportedReason) {
				return {
					verdict: "continue",
					reason: unsupportedReason,
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

function createEvaluatorSession(ctx: ExtensionContext): SessionManager {
	const parentSession = ctx.sessionManager.getSessionFile()
	return parentSession
		? SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), { parentSession })
		: SessionManager.inMemory(ctx.cwd)
}

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

function unsupportedMetReason(
	checks: FermentV2EvaluatorCheck[] | undefined,
	evidenceIds: ReadonlySet<string>,
	todos: readonly TodoItem[],
): string | undefined {
	if (!checks?.length) return "Completion checks are missing; verify each objective requirement with retained evidence."
	const todoIds = new Set(todos.map((todo) => todo.id))
	for (const check of checks) {
		const requirement = JSON.stringify(check.requirement.slice(0, 200))
		if (!check.met) return `Requirement ${requirement} is not met; continue work and verify it.`
		if (!check.failureMode)
			return `Requirement ${requirement} does not name the plausible failure mode ruled out by its evidence; inspect the risk and verify it.`
		if (check.evidence.length === 0)
			return `Requirement ${requirement} has no retained evidence; run a relevant check and surface its result.`
		if (check.evidence.some((evidenceId) => !evidenceIds.has(evidenceId)))
			return `Requirement ${requirement} cites evidence that is not retained as authoritative; gather and surface current observable evidence.`
		const unknownTodoId = check.todoIds.find((todoId) => !todoIds.has(todoId))
		if (unknownTodoId !== undefined)
			return `Requirement ${requirement} cites unknown Todo ${unknownTodoId}; reconcile the Todo list and completion checks.`
	}
	const coveredTodoIds = new Set(checks.flatMap((check) => check.todoIds))
	const uncoveredTodo = todos.find(
		(todo) => (todo.status === "completed" || todo.status === "blocked") && !coveredTodoIds.has(todo.id),
	)
	return uncoveredTodo
		? `Settled Todo ${uncoveredTodo.id} is not covered by a completion check; verify it against the objective.`
		: undefined
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

function renderFermentV2Lessons(lessons: readonly FermentV2Lesson[] | undefined): {
	text: string
	evidenceIds: ReadonlySet<string>
} {
	const entries = (lessons ?? []).slice(-MAX_FERMENT_V2_LESSONS).map((lesson) => {
		const id = `l${lesson.todoId}`
		return {
			id,
			kind: lesson.kind,
			text: `[${id}] [lesson todo ${lesson.todoId} ${lesson.kind}] ${lesson.text.slice(0, MAX_FERMENT_V2_LESSON_CHARS)}`,
		}
	})
	return {
		text: entries.map((entry) => entry.text).join("\n\n"),
		evidenceIds: new Set(entries.filter((entry) => entry.kind === "evidence").map((entry) => entry.id)),
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
	const { units, linkedToolResultIndexes, callLabelsById } = buildTranscriptUnits(messages)
	const keptIndexes = new Set<number>()
	const kept: RenderedTranscriptEntry[] = []
	let length = 0
	for (let unitIndex = units.length - 1; unitIndex >= 0; unitIndex--) {
		const entries = units[unitIndex]
			.map((index) => renderTranscriptEntry(messages[index], index, linkedToolResultIndexes, callLabelsById))
			.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
		if (entries.length === 0) continue
		const unitText = entries.map(({ prefix, content }) => prefix + content).join("\n\n")
		const separatorLength = kept.length > 0 ? 2 : 0
		if (length + separatorLength + unitText.length <= MAX_TRANSCRIPT_CHARS) {
			for (const entry of entries) {
				if (keptIndexes.has(entry.index)) continue
				keptIndexes.add(entry.index)
				kept.push(entry)
			}
			length += separatorLength + unitText.length
			continue
		}
		if (kept.length === 0) kept.push(...clipTranscriptUnit(entries, MAX_TRANSCRIPT_CHARS))
		break
	}
	const ordered = kept.sort((a, b) => a.index - b.index)
	return {
		text: ordered.map(({ prefix, content }) => prefix + content).join("\n\n"),
		evidenceIds: new Set(ordered.filter((entry) => entry.evidence).map((entry) => entry.id)),
	}
}

function clipTranscriptUnit(entries: readonly RenderedTranscriptEntry[], limit: number): RenderedTranscriptEntry[] {
	const separatorChars = Math.max(0, entries.length - 1) * 2
	const prefixChars = entries.reduce((total, entry) => total + entry.prefix.length, 0)
	let remainingChars = limit - separatorChars - prefixChars
	if (remainingChars < entries.length) return []

	const clipped: RenderedTranscriptEntry[] = []
	for (const [index, entry] of entries.entries()) {
		const entriesLeft = entries.length - index
		const contentChars = Math.floor(remainingChars / entriesLeft)
		const content = entry.content.slice(-contentChars)
		remainingChars -= content.length
		clipped.push({ ...entry, content })
	}
	return clipped
}

function buildTranscriptUnits(messages: ReadonlyArray<AgentEndEvent["messages"][number]>): {
	units: number[][]
	linkedToolResultIndexes: ReadonlySet<number>
	callLabelsById: ReadonlyMap<string, string>
} {
	const resultsByCallId = new Map<string, number[]>()
	messages.forEach((message, index) => {
		const toolCallId = toolResultCallId(message)
		if (!toolCallId) return
		const indexes = resultsByCallId.get(toolCallId) ?? []
		indexes.push(index)
		resultsByCallId.set(toolCallId, indexes)
	})

	const assigned = new Set<number>()
	const linkedToolResultIndexes = new Set<number>()
	const callLabelsById = new Map<string, string>()
	const units: number[][] = []
	for (let index = 0; index < messages.length; index++) {
		if (assigned.has(index)) continue
		const callIds = toolCallIds(messages[index])
		callIds.forEach((callId, callIndex) => {
			callLabelsById.set(callId, `c${index + 1}.${callIndex + 1}`)
		})
		const unit = new Set([index])
		for (const callId of callIds) {
			for (const resultIndex of resultsByCallId.get(callId) ?? []) {
				unit.add(resultIndex)
				linkedToolResultIndexes.add(resultIndex)
			}
		}
		const indexes = [...unit].sort((a, b) => a - b)
		for (const assignedIndex of indexes) assigned.add(assignedIndex)
		units.push(indexes)
	}
	return {
		units: units.sort((a, b) => (a.at(-1) ?? 0) - (b.at(-1) ?? 0)),
		linkedToolResultIndexes,
		callLabelsById,
	}
}

function renderTranscriptEntry(
	message: AgentEndEvent["messages"][number],
	index: number,
	linkedToolResultIndexes: ReadonlySet<number>,
	callLabelsById: ReadonlyMap<string, string>,
): RenderedTranscriptEntry | undefined {
	const rendered = renderMessage(message, callLabelsById)
	if (!rendered) return undefined
	const id = `m${index + 1}`
	return {
		index,
		id,
		prefix: `[${id}] ${rendered.prefix}`,
		content: rendered.content,
		evidence: linkedToolResultIndexes.has(index),
	}
}

function toolResultCallId(message: AgentEndEvent["messages"][number]): string | undefined {
	const record = message as unknown as Record<string, unknown>
	if (record.role !== "toolResult" || typeof record.toolCallId !== "string" || !record.toolCallId.trim()) {
		return undefined
	}
	return record.toolCallId
}

function toolCallIds(message: AgentEndEvent["messages"][number]): string[] {
	const content = (message as unknown as Record<string, unknown>).content
	if (!Array.isArray(content)) return []
	return content.flatMap((part) =>
		isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && part.id.trim() ? [part.id] : [],
	)
}

function renderMessage(
	message: AgentEndEvent["messages"][number],
	callLabelsById: ReadonlyMap<string, string> = new Map(),
): { prefix: string; content: string } | undefined {
	const record = message as unknown as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : "message"
	const toolName = typeof record.toolName === "string" ? ` ${record.toolName}` : ""
	const callLabel = callLabelsById.get(toolResultCallId(message) ?? "")
	const resultLink = role === "toolResult" && callLabel ? ` for ${callLabel}` : ""
	const content = contentText(record.content, callLabelsById)
	if (!content) return undefined
	const normalizedContent = content.trimEnd()
	if (!normalizedContent.trim()) return { prefix: `[${role}${toolName}${resultLink}]`, content: "" }
	return { prefix: `[${role}${toolName}${resultLink}] `, content: normalizedContent }
}

function contentText(content: unknown, callLabelsById: ReadonlyMap<string, string>): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			if (!isRecord(part)) return ""
			if (part.type === "thinking") return ""
			if (typeof part.text === "string") return part.text
			if (part.type === "toolCall" && typeof part.name === "string") {
				const callLabel = typeof part.id === "string" ? callLabelsById.get(part.id) : undefined
				return `tool ${callLabel ? `${callLabel} ` : ""}${part.name} ${JSON.stringify(part.arguments ?? {})}`
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
}
