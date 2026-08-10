import { isDeepStrictEqual } from "node:util"
import type { Api, Context, Model } from "@earendil-works/pi-ai"
import type { ChangeSet } from "../../agent-patch/index.js"
import { redactObjectStrings } from "../pii-redaction/redactor.js"
import { truncateUtf8 } from "./physical-invoker.js"
import type {
	AssistantTextArtifact,
	CandidatePatchArtifact,
	EvidenceArtifact,
	EvidenceContent,
	JsonObject,
	JsonValue,
	SystemInstructionArtifact,
	ToolCallArtifact,
	ToolResultArtifact,
	ToolResultMetadata,
	UserTextArtifact,
} from "./schemas.js"

const DEFAULT_MAX_EVIDENCE_BYTES = 128 * 1024
const DEFAULT_CONTEXT_OVERHEAD_TOKENS = 1024
const DEFAULT_CONTEXT_SAFETY_MARGIN = 0.95
const CONTEXT_TRUNCATION_NOTICE = "Context truncated to fit the selected physical model."

export interface CompiledCouncilContext {
	schema_version: 1
	run_id: string
	objective: { artifact_id: string; text: string }
	artifacts: EvidenceArtifact[]
	lead_draft?: { trust: "untrusted_assistant_output"; text: string }
	truncation: {
		truncated: boolean
		omitted_artifact_ids: string[]
	}
}

export interface CouncilConstraint {
	artifact_id: string
	text: string
}

export interface CompileCouncilContextOptions {
	context: Context
	runId: string
	leadDraft?: string
	candidate?: ChangeSet
	maxEvidenceBytes?: number
}

export interface ModelContextLimits {
	model: Pick<Model<Api>, "provider" | "id" | "contextWindow">
	requestedMaxOutputTokens: number
	safetyMargin?: number
	overheadTokens?: number
}

export interface FittedPiContext {
	context: Context
	modelRef: string
	estimatedInputTokens: number
	maxOutputTokens: number
	truncated: boolean
}

export type ContextCompilerErrorCode = "invalid_context" | "redaction_failed" | "evidence_limit" | "context_limit"

export class ContextCompilerError extends Error {
	readonly code: ContextCompilerErrorCode

	constructor(code: ContextCompilerErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "ContextCompilerError"
		this.code = code
	}
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value))
}

function estimatedTokens(value: unknown): number {
	return Math.ceil(byteLength(value) / 4)
}

function truncateHeadTail(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value) <= maximumBytes) return value
	const marker = "\n...[truncated]...\n"
	const budget = Math.max(0, maximumBytes - Buffer.byteLength(marker))
	const head = Math.ceil(budget / 2)
	const tail = budget - head
	const bytes = Buffer.from(value)
	let start = Math.max(0, bytes.length - tail)
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
	return `${truncateUtf8(value, head)}${marker}${bytes.subarray(start).toString("utf8")}`
}

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (typeof value === "bigint") return value.toString()
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null
	if (typeof value !== "object") return String(value)
	if (seen.has(value)) throw new ContextCompilerError("invalid_context", "Council evidence contains a cycle")
	seen.add(value)
	try {
		if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen))
		if (value instanceof Date) return value.toISOString()
		const result: JsonObject = {}
		for (const [key, item] of Object.entries(value)) result[key] = toJsonValue(item, seen)
		return result
	} finally {
		seen.delete(value)
	}
}

function toJsonObject(value: unknown): JsonObject {
	const normalized = toJsonValue(value)
	return normalized && typeof normalized === "object" && !Array.isArray(normalized)
		? (normalized as JsonObject)
		: { value: normalized }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function findMetadataValue(value: unknown, keys: readonly string[], depth = 0): unknown {
	if (depth > 3) return undefined
	const record = asRecord(value)
	if (!record) return undefined
	for (const key of keys) {
		if (record[key] !== undefined) return record[key]
	}
	for (const nested of Object.values(record)) {
		const found = findMetadataValue(nested, keys, depth + 1)
		if (found !== undefined) return found
	}
	return undefined
}

function firstString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function toolResultMetadata(
	message: Context["messages"][number] & { role: "toolResult" },
	call: ToolCallArtifact | undefined,
): ToolResultMetadata {
	const args = call?.tool_call.arguments
	const details = message.details
	const path = firstString(
		findMetadataValue(details, ["path", "filePath", "file_path", "fullOutputPath"]),
		findMetadataValue(args, ["path", "filePath", "file_path"]),
	)
	const command = firstString(findMetadataValue(details, ["command"]), findMetadataValue(args, ["command"]))
	return {
		...(path ? { path } : {}),
		...(command ? { command } : {}),
	}
}

function evidenceContent(
	content: (Context["messages"][number] & { role: "toolResult" })["content"],
): EvidenceContent[] {
	return content.map((part) =>
		part.type === "text" ? { type: "text", text: part.text } : { type: "image", mime_type: part.mimeType },
	)
}

function compileArtifacts(context: Context): EvidenceArtifact[] {
	const artifacts: EvidenceArtifact[] = []
	const calls = new Map<string, ToolCallArtifact>()
	let sequence = 0
	if (context.systemPrompt) {
		const artifact: SystemInstructionArtifact = {
			artifact_id: "artifact_system_0",
			kind: "system_instruction",
			sequence: sequence++,
			message_index: null,
			block_index: null,
			trust: "trusted_system_instruction",
			text: context.systemPrompt,
		}
		artifacts.push(artifact)
	}
	for (const [messageIndex, message] of context.messages.entries()) {
		if (message.role === "user") {
			const blocks =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
			for (const [blockIndex, block] of blocks.entries()) {
				if (block.type !== "text") continue
				const artifact: UserTextArtifact = {
					artifact_id: `artifact_message_${messageIndex}_block_${blockIndex}_user_text`,
					kind: "user_text",
					sequence: sequence++,
					message_index: messageIndex,
					block_index: blockIndex,
					trust: "trusted_user_instruction",
					text: block.text,
				}
				artifacts.push(artifact)
			}
			continue
		}
		if (message.role === "assistant") {
			for (const [blockIndex, block] of message.content.entries()) {
				if (block.type === "text") {
					const artifact: AssistantTextArtifact = {
						artifact_id: `artifact_message_${messageIndex}_block_${blockIndex}_assistant_text`,
						kind: "assistant_text",
						sequence: sequence++,
						message_index: messageIndex,
						block_index: blockIndex,
						trust: "untrusted_assistant_output",
						text: block.text,
					}
					artifacts.push(artifact)
				} else if (block.type === "toolCall") {
					const artifact: ToolCallArtifact = {
						artifact_id: `artifact_message_${messageIndex}_block_${blockIndex}_tool_call`,
						kind: "tool_call",
						sequence: sequence++,
						message_index: messageIndex,
						block_index: blockIndex,
						trust: "untrusted_assistant_output",
						tool_call: { id: block.id, name: block.name, arguments: toJsonObject(block.arguments) },
					}
					artifacts.push(artifact)
					calls.set(block.id, artifact)
				}
			}
			continue
		}
		const content = evidenceContent(message.content)
		const artifact: ToolResultArtifact = {
			artifact_id: `artifact_message_${messageIndex}_tool_result`,
			kind: "tool_result",
			sequence: sequence++,
			message_index: messageIndex,
			block_index: null,
			trust: "untrusted_tool_output",
			tool_result: {
				id: message.toolCallId,
				name: message.toolName,
				is_error: message.isError,
				content,
				metadata: toolResultMetadata(message, calls.get(message.toolCallId)),
			},
		}
		artifacts.push(artifact)
	}
	return artifacts
}

function truncateArtifact(artifact: EvidenceArtifact, maximumBytes: number): EvidenceArtifact {
	const copy = structuredClone(artifact)
	copy.truncated = true
	if (copy.kind === "system_instruction" || copy.kind === "user_text" || copy.kind === "assistant_text") {
		copy.text = truncateHeadTail(copy.text, Math.max(128, maximumBytes))
	} else if (copy.kind === "tool_call") {
		const serialized = JSON.stringify(copy.tool_call.arguments)
		if (Buffer.byteLength(serialized) > maximumBytes) {
			copy.tool_call.arguments = {
				_truncated: true,
				preview: truncateHeadTail(serialized, Math.max(128, maximumBytes)),
			}
		}
	} else if (copy.kind === "tool_result") {
		copy.tool_result.content = copy.tool_result.content.map((part) =>
			part.type === "text" ? { ...part, text: truncateHeadTail(part.text, Math.max(128, maximumBytes)) } : part,
		)
		if (copy.tool_result.metadata.path)
			copy.tool_result.metadata.path = truncateHeadTail(copy.tool_result.metadata.path, 1024)
		if (copy.tool_result.metadata.command)
			copy.tool_result.metadata.command = truncateHeadTail(copy.tool_result.metadata.command, 2048)
	}
	return copy
}

export function boundCompiledContext(context: CompiledCouncilContext, maximumBytes: number): CompiledCouncilContext {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) {
		throw new ContextCompilerError("evidence_limit", "Council evidence limit must be at least 1024 bytes")
	}
	if (byteLength(context) <= maximumBytes) return context
	const working = structuredClone(context)
	working.objective.text = truncateHeadTail(working.objective.text, Math.max(256, Math.floor(maximumBytes / 8)))
	if (working.lead_draft) {
		working.lead_draft.text = truncateHeadTail(working.lead_draft.text, Math.max(512, Math.floor(maximumBytes / 3)))
	}
	working.artifacts = working.artifacts.map((artifact) =>
		artifact.kind === "system_instruction"
			? truncateArtifact(artifact, Math.max(256, Math.floor(maximumBytes / 8)))
			: artifact.artifact_id === working.objective.artifact_id
				? truncateArtifact(artifact, Math.max(256, Math.floor(maximumBytes / 8)))
				: artifact,
	)
	const mandatoryIds = new Set([
		working.objective.artifact_id,
		...working.artifacts.filter(({ kind }) => kind === "system_instruction").map(({ artifact_id }) => artifact_id),
		...working.artifacts.filter(({ kind }) => kind === "candidate_patch").map(({ artifact_id }) => artifact_id),
	])
	const mandatory = working.artifacts.filter(({ artifact_id }) => mandatoryIds.has(artifact_id))
	const optional = working.artifacts.filter(({ artifact_id }) => !mandatoryIds.has(artifact_id))
	working.artifacts = mandatory
	working.truncation = { truncated: true, omitted_artifact_ids: optional.map(({ artifact_id }) => artifact_id) }
	for (let index = optional.length - 1; index >= 0; index--) {
		const artifact = optional[index]
		const candidate = [...working.artifacts, artifact].sort((left, right) => left.sequence - right.sequence)
		const previous = working.artifacts
		working.artifacts = candidate
		if (byteLength(working) <= maximumBytes) {
			working.truncation.omitted_artifact_ids = working.truncation.omitted_artifact_ids.filter(
				(id) => id !== artifact.artifact_id,
			)
		} else working.artifacts = previous
	}
	if (byteLength(working) > maximumBytes) {
		working.artifacts = working.artifacts.map((artifact) =>
			artifact.kind === "candidate_patch"
				? artifact
				: truncateArtifact(artifact, Math.max(128, Math.floor(maximumBytes / 12))),
		)
	}
	if (byteLength(working) > maximumBytes) {
		throw new ContextCompilerError("evidence_limit", "Council evidence cannot fit its byte limit")
	}
	return working
}

export async function compileCouncilContext({
	context,
	runId,
	leadDraft,
	candidate,
	maxEvidenceBytes = DEFAULT_MAX_EVIDENCE_BYTES,
}: CompileCouncilContextOptions): Promise<CompiledCouncilContext> {
	const artifacts = compileArtifacts(context)
	const objective = [...artifacts]
		.reverse()
		.find((artifact): artifact is UserTextArtifact => artifact.kind === "user_text")
	if (!objective?.text.trim())
		throw new ContextCompilerError("invalid_context", "Council context has no user objective")
	let sequence = artifacts.reduce((maximum, artifact) => Math.max(maximum, artifact.sequence), -1) + 1
	if (candidate) {
		const candidateArtifact: CandidatePatchArtifact = {
			artifact_id: "artifact_candidate_patch",
			kind: "candidate_patch",
			sequence: sequence++,
			message_index: null,
			block_index: null,
			trust: "untrusted_assistant_output",
			candidate_patch: {
				transaction_id: candidate.transactionId,
				patch_sha256: candidate.patchSha256,
				operations: candidate.operations.map((operation) => ({
					kind: operation.kind,
					path: operation.path,
					...(operation.kind === "rename" ? { from_path: operation.fromPath } : {}),
					...(operation.kind === "create" ? {} : { base_sha256: operation.baseSha256 }),
				})),
				stats: {
					files: candidate.stats.files,
					added_lines: candidate.stats.addedLines,
					removed_lines: candidate.stats.removedLines,
					patch_bytes: candidate.stats.patchBytes,
				},
				patch: candidate.patch,
			},
		}
		artifacts.push(candidateArtifact)
	}
	const packet: CompiledCouncilContext = {
		schema_version: 1,
		run_id: runId,
		objective: { artifact_id: objective.artifact_id, text: objective.text },
		artifacts,
		...(leadDraft === undefined
			? {}
			: { lead_draft: { trust: "untrusted_assistant_output" as const, text: leadDraft } }),
		truncation: { truncated: false, omitted_artifact_ids: [] },
	}
	// The candidate patch must come back byte-identical: panel stages and the applied patch must see
	// the exact same content.
	const candidateIndex = packet.artifacts.findIndex(({ kind }) => kind === "candidate_patch")
	const originalCandidate =
		candidateIndex === -1 ? undefined : (packet.artifacts[candidateIndex] as CandidatePatchArtifact)
	const packetWithoutCandidate =
		candidateIndex === -1
			? packet
			: { ...packet, artifacts: packet.artifacts.filter((_, index) => index !== candidateIndex) }
	let redacted: CompiledCouncilContext
	try {
		const [redactedPacket, redactedCandidate] = await Promise.all([
			redactObjectStrings(packetWithoutCandidate, { failClosed: true }),
			originalCandidate
				? redactObjectStrings(originalCandidate, { failClosed: true, preserveSha256: true })
				: Promise.resolve(undefined),
		])
		if (originalCandidate && !isDeepStrictEqual(redactedCandidate, originalCandidate)) {
			throw new ContextCompilerError("redaction_failed", "Council cannot review altered candidate evidence")
		}
		redacted =
			originalCandidate && candidateIndex !== -1
				? {
						...redactedPacket,
						artifacts: [
							...redactedPacket.artifacts.slice(0, candidateIndex),
							originalCandidate,
							...redactedPacket.artifacts.slice(candidateIndex),
						],
					}
				: redactedPacket
	} catch (error) {
		if (error instanceof ContextCompilerError) throw error
		throw new ContextCompilerError("redaction_failed", "Council evidence redaction failed", { cause: error })
	}
	return boundCompiledContext(redacted, maxEvidenceBytes)
}

const MAX_SYSTEM_CONSTRAINT_BYTES = 12 * 1024
const SYSTEM_CONSTRAINT_SECTION_BYTES = new Map([
	["guidelines", 4 * 1024],
	["factual accuracy", 3 * 1024],
	["project guidelines", 8 * 1024],
	["council constraints", 4 * 1024],
])

export function councilConstraints(context: CompiledCouncilContext): CouncilConstraint[] {
	return context.artifacts
		.filter((artifact): artifact is SystemInstructionArtifact => artifact.kind === "system_instruction")
		.map(({ artifact_id, text }) => ({ artifact_id, text: relevantSystemConstraints(text) }))
}

function relevantSystemConstraints(systemPrompt: string): string {
	const headings = [...systemPrompt.matchAll(/^## ([^\n]+)\s*$/gm)]
	const selected = headings.flatMap((match, index) => {
		const heading = match[1]?.trim()
		const limit = heading ? SYSTEM_CONSTRAINT_SECTION_BYTES.get(heading.toLowerCase()) : undefined
		if (!heading || !limit || match.index === undefined) return []
		const start = match.index
		const end = headings[index + 1]?.index ?? systemPrompt.length
		return [truncateHeadTail(systemPrompt.slice(start, end).trim(), limit)]
	})
	const relevant = selected.join("\n\n")
	return truncateHeadTail(relevant || systemPrompt, MAX_SYSTEM_CONSTRAINT_BYTES)
}

function contextWindowBudget(limits: ModelContextLimits): {
	safeWindow: number
	requestedOutput: number
	overheadTokens: number
} {
	const safetyMargin = limits.safetyMargin ?? DEFAULT_CONTEXT_SAFETY_MARGIN
	const overheadTokens = limits.overheadTokens ?? DEFAULT_CONTEXT_OVERHEAD_TOKENS
	const safeWindow = Math.floor(limits.model.contextWindow * safetyMargin)
	const requestedOutput = Math.max(1, Math.floor(limits.requestedMaxOutputTokens))
	return { safeWindow, requestedOutput, overheadTokens }
}

function finalizeContextFit(
	modelRef: string,
	inputTokens: number,
	safeWindow: number,
	requestedOutput: number,
	truncated: boolean,
	overLimitMessage: string,
): Omit<FittedPiContext, "context"> & { truncated: boolean } {
	const maxOutputTokens = Math.min(requestedOutput, safeWindow - inputTokens)
	if (maxOutputTokens <= 0) throw new ContextCompilerError("context_limit", overLimitMessage)
	return { modelRef, estimatedInputTokens: inputTokens, maxOutputTokens, truncated }
}

export function contextInputByteBudget(limits: ModelContextLimits): number {
	const { safeWindow, requestedOutput, overheadTokens } = contextWindowBudget(limits)
	const maximumInputTokens =
		safeWindow - Math.min(requestedOutput, Math.max(1, safeWindow - overheadTokens - 1)) - overheadTokens
	if (maximumInputTokens <= 0)
		throw new ContextCompilerError("context_limit", "Physical model context window is too small")
	return maximumInputTokens * 4
}

export function fitContextToModel(
	context: Context,
	limits: ModelContextLimits,
	inputTokenHint?: number,
): FittedPiContext {
	const { safeWindow, requestedOutput, overheadTokens } = contextWindowBudget(limits)
	let start = 0
	let messages = context.messages
	let inputTokens = Math.max(inputTokenHint ?? 0, estimatedTokens(context)) + overheadTokens
	let protectedStart = 0
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			protectedStart = index
			break
		}
	}
	while (start < protectedStart && inputTokens + requestedOutput > safeWindow) {
		start++
		while (start < protectedStart && messages[start]?.role === "toolResult") start++
		inputTokens = estimatedTokens({ ...context, messages: messages.slice(start) }) + overheadTokens
	}
	let truncated = false
	if (start > 0) {
		truncated = true
		messages = [{ role: "user", content: CONTEXT_TRUNCATION_NOTICE, timestamp: 0 }, ...messages.slice(start)]
		inputTokens = estimatedTokens({ ...context, messages }) + overheadTokens
	}
	return {
		context: messages === context.messages ? context : { ...context, messages },
		...finalizeContextFit(
			`${limits.model.provider}/${limits.model.id}`,
			inputTokens,
			safeWindow,
			requestedOutput,
			truncated,
			"Council context exceeds the model window",
		),
	}
}
