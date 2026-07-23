import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { Api, Context, Model, ToolCall } from "@earendil-works/pi-ai"
import type { ChangeSet } from "../../agent-patch/index.js"
import { redactObjectStrings } from "../pii-redaction/redactor.js"
import type {
	AssistantTextArtifact,
	CandidatePatchArtifact,
	CandidateValidationArtifact,
	EvidenceArtifact,
	EvidenceContent,
	JsonObject,
	JsonValue,
	ReviewerRole,
	SystemInstructionArtifact,
	ToolCallArtifact,
	ToolResultArtifact,
	ToolResultMetadata,
	UserTextArtifact,
} from "./schemas.js"
import type { validationCatalogForPrompt } from "./validation.js"

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

export interface CouncilRequirement {
	id: string
	text: string
}

export interface CouncilConstraint {
	artifact_id: string
	text: string
}

export type ValidationCatalogEntry = ReturnType<typeof validationCatalogForPrompt>[number]

interface RoleContextBase {
	schema_version: 1
	run_id: string
	role: ReviewerRole
	objective: CompiledCouncilContext["objective"]
	requirements: CouncilRequirement[]
	constraints: CouncilConstraint[]
	evidence: EvidenceArtifact[]
	truncation: CompiledCouncilContext["truncation"]
}

export interface IndependentRoleContext extends RoleContextBase {
	role: "independent"
}

export interface CriticRoleContext extends RoleContextBase {
	role: "critic"
	lead_draft: NonNullable<CompiledCouncilContext["lead_draft"]>
}

export interface CheckerRoleContext extends RoleContextBase {
	role: "checker"
	validation_catalog: ValidationCatalogEntry[]
}

export type RoleContextArtifact = IndependentRoleContext | CriticRoleContext | CheckerRoleContext

export interface CompileCouncilContextOptions {
	context: Context
	runId: string
	leadDraft?: string
	candidate?: ChangeSet
	candidateValidation?: CandidateValidationArtifact["candidate_validation"]
	maxEvidenceBytes?: number
}

export interface ModelContextLimits {
	model: Pick<Model<Api>, "provider" | "id" | "contextWindow">
	requestedMaxOutputTokens: number
	safetyMargin?: number
	overheadTokens?: number
}

export interface FittedRoleContext {
	context: RoleContextArtifact
	modelRef: string
	estimatedInputTokens: number
	maxOutputTokens: number
	truncated: boolean
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

function truncateUtf8(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) return ""
	const bytes = Buffer.from(value)
	if (bytes.length <= maximumBytes) return value
	let end = maximumBytes
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
	return bytes.subarray(0, end).toString("utf8")
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

function firstFiniteNumber(...values: unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === "number" && Number.isFinite(value))
}

function contentText(content: EvidenceContent[]): string {
	return content.map((part) => (part.type === "text" ? part.text : `[image:${part.mime_type}]`)).join("\n")
}

function countResult(text: string, label: "passed" | "failed" | "skipped"): number | undefined {
	const match = text.match(new RegExp(`(?:^|\\s)(\\d+)\\s+${label}(?:\\s|,|$)`, "i"))
	return match ? Number(match[1]) : undefined
}

function looksLikeTestCommand(command: string | undefined): boolean {
	return (
		command !== undefined &&
		/(?:^|\s)(?:vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test|pnpm\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|yarn\s+test)(?:\s|$)/i.test(
			command,
		)
	)
}

function toolResultMetadata(
	message: Context["messages"][number] & { role: "toolResult" },
	call: ToolCallArtifact | undefined,
	content: EvidenceContent[],
): ToolResultMetadata {
	const args = call?.tool_call.arguments
	const details = message.details
	const text = contentText(content)
	const path = firstString(
		findMetadataValue(details, ["path", "filePath", "file_path", "fullOutputPath"]),
		findMetadataValue(args, ["path", "filePath", "file_path"]),
	)
	const command = firstString(findMetadataValue(details, ["command"]), findMetadataValue(args, ["command"]))
	const contentExit = text.match(/(?:exited with code|exit(?:ed)?(?: code)?[:=]?)\s*(-?\d+)/i)
	const exitCode = firstFiniteNumber(
		findMetadataValue(details, ["exitCode", "exit_code", "code"]),
		contentExit ? Number(contentExit[1]) : undefined,
		message.toolName === "bash" && !message.isError ? 0 : undefined,
	)
	const signal = firstString(findMetadataValue(details, ["signal"]))
	const passed = countResult(text, "passed")
	const failed = countResult(text, "failed")
	const skipped = countResult(text, "skipped")
	const isTest = looksLikeTestCommand(command) || passed !== undefined || failed !== undefined || skipped !== undefined
	let test: ToolResultMetadata["test"]
	if (isTest) {
		const status =
			message.isError || (failed ?? 0) > 0
				? "failed"
				: (passed ?? 0) > 0
					? "passed"
					: (skipped ?? 0) > 0
						? "skipped"
						: "unknown"
		test = {
			status,
			...(passed === undefined ? {} : { passed }),
			...(failed === undefined ? {} : { failed }),
			...(skipped === undefined ? {} : { skipped }),
		}
	}
	const errorCode = firstString(findMetadataValue(details, ["errorCode", "error_code"]))
	return {
		...(path ? { path } : {}),
		...(command ? { command } : {}),
		...(exitCode === undefined && !signal ? {} : { exit: { code: exitCode ?? null, ...(signal ? { signal } : {}) } }),
		...(test ? { test } : {}),
		...(message.isError
			? { error: { message: text || "Tool failed", ...(errorCode ? { code: errorCode } : {}) } }
			: {}),
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
				metadata: toolResultMetadata(message, calls.get(message.toolCallId), content),
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
		if (copy.tool_result.metadata.error)
			copy.tool_result.metadata.error.message = truncateHeadTail(copy.tool_result.metadata.error.message, 2048)
	}
	return copy
}

function boundCompiledContext(context: CompiledCouncilContext, maximumBytes: number): CompiledCouncilContext {
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
		...working.artifacts
			.filter(({ kind }) => kind === "candidate_patch" || kind === "candidate_validation")
			.map(({ artifact_id }) => artifact_id),
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
			artifact.kind === "candidate_patch" || artifact.kind === "candidate_validation"
				? artifact
				: truncateArtifact(artifact, Math.max(128, Math.floor(maximumBytes / 12))),
		)
	}
	if (byteLength(working) > maximumBytes) {
		throw new ContextCompilerError("evidence_limit", "Council evidence cannot fit its byte limit")
	}
	return working
}

type CandidateOperation = CandidatePatchArtifact["candidate_patch"]["operations"][number]

function candidateHashToken(kind: "patch" | "base", index = 0): string {
	return `__KIMCHI_CANDIDATE_${kind.toUpperCase()}_SHA256_${index}__`
}

function replaceCandidateHeaderHash(patch: string, operation: CandidateOperation, from: string, to: string): string {
	let prefix: string
	if (operation.kind === "update") prefix = `# update ${operation.path} base=${from}`
	else if (operation.kind === "delete") prefix = `# delete ${operation.path} base=${from}`
	else if (operation.kind === "rename") prefix = `# rename ${operation.from_path} -> ${operation.path} base=${from}`
	else throw new ContextCompilerError("invalid_context", "Create operations do not have base hashes")

	const lines = patch.split("\n")
	const matches = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => (operation.kind === "delete" ? line === prefix : line.startsWith(`${prefix} mode=`)))
	if (matches.length !== 1) {
		throw new ContextCompilerError("invalid_context", "Candidate base hash does not match its patch metadata")
	}
	lines[matches[0].index] = matches[0].line.replace(`base=${from}`, `base=${to}`)
	return lines.join("\n")
}

function protectCandidateHashes(original: CandidatePatchArtifact): CandidatePatchArtifact {
	const patchToken = candidateHashToken("patch")
	const baseTokens = original.candidate_patch.operations.map((operation, index) =>
		operation.base_sha256 ? candidateHashToken("base", index) : undefined,
	)
	const serialized = JSON.stringify(original)
	if ([patchToken, ...baseTokens].some((token) => token && serialized.includes(token))) {
		throw new ContextCompilerError("invalid_context", "Candidate collides with reserved hash metadata")
	}

	let protectedPatch = original.candidate_patch.patch
	const protectedOperations = original.candidate_patch.operations.map((operation, index) => {
		const token = baseTokens[index]
		if (!token || !operation.base_sha256) return operation
		protectedPatch = replaceCandidateHeaderHash(protectedPatch, operation, operation.base_sha256, token)
		return { ...operation, base_sha256: token }
	})
	const protectedCandidate: CandidatePatchArtifact = {
		...original,
		candidate_patch: {
			...original.candidate_patch,
			patch_sha256: patchToken,
			operations: protectedOperations,
			patch: protectedPatch,
		},
	}
	return protectedCandidate
}

export async function compileCouncilContext({
	context,
	runId,
	leadDraft,
	candidate,
	candidateValidation,
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
	if (candidateValidation) {
		const validationArtifact: CandidateValidationArtifact = {
			artifact_id: "artifact_candidate_validation",
			kind: "candidate_validation",
			sequence,
			message_index: null,
			block_index: null,
			trust: "untrusted_tool_output",
			candidate_validation: candidateValidation,
		}
		artifacts.push(validationArtifact)
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
	const candidateIndex = packet.artifacts.findIndex(({ kind }) => kind === "candidate_patch")
	const originalCandidate =
		candidateIndex === -1 ? undefined : (packet.artifacts[candidateIndex] as CandidatePatchArtifact)
	const protectedCandidate = originalCandidate ? protectCandidateHashes(originalCandidate) : undefined
	const packetWithoutCandidate =
		candidateIndex === -1
			? packet
			: { ...packet, artifacts: packet.artifacts.filter((_, index) => index !== candidateIndex) }
	let redacted: CompiledCouncilContext
	try {
		const [redactedPacket, redactedCandidate] = await Promise.all([
			redactObjectStrings(packetWithoutCandidate, { failClosed: true }),
			protectedCandidate ? redactObjectStrings(protectedCandidate, { failClosed: true }) : Promise.resolve(undefined),
		])
		if (protectedCandidate && !isDeepStrictEqual(redactedCandidate, protectedCandidate)) {
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

const STAGED_MUTATION_TOOLS = new Set(["edit", "write", "council_delete_file", "council_rename_file"])
const MAX_REQUIREMENTS = 20
const MAX_SYSTEM_CONSTRAINT_BYTES = 12 * 1024
const SYSTEM_CONSTRAINT_SECTION_BYTES = new Map([
	["guidelines", 4 * 1024],
	["factual accuracy", 3 * 1024],
	["project guidelines", 8 * 1024],
	["council constraints", 4 * 1024],
])

export function councilRequirements(context: CompiledCouncilContext): CouncilRequirement[] {
	const lines = context.objective.text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	const statements = lines.length > 1 ? lines : [context.objective.text.trim()]
	const unique = [...new Set(statements)].slice(0, MAX_REQUIREMENTS)
	return unique.map((text) => ({
		id: `requirement_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
		text,
	}))
}

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

function independentEvidence(context: CompiledCouncilContext): EvidenceArtifact[] {
	const objective = context.artifacts.find(({ artifact_id }) => artifact_id === context.objective.artifact_id)
	if (objective?.kind !== "user_text" || objective.message_index === null) {
		throw new ContextCompilerError("invalid_context", "Council context has no current user turn")
	}
	const turnStart = objective.message_index
	const firstMutation = context.artifacts.find(
		(artifact) =>
			artifact.kind === "tool_call" &&
			artifact.message_index !== null &&
			artifact.message_index >= turnStart &&
			STAGED_MUTATION_TOOLS.has(artifact.tool_call.name),
	)
	const cutoff = firstMutation?.sequence ?? Number.POSITIVE_INFINITY
	return context.artifacts.filter(
		(artifact) =>
			(artifact.kind === "tool_call" || artifact.kind === "tool_result") &&
			artifact.message_index !== null &&
			artifact.message_index >= turnStart &&
			artifact.sequence < cutoff,
	)
}

function matchesAffectedPath(path: string | undefined, affectedPaths: ReadonlySet<string>): boolean {
	if (!path) return false
	const normalized = path.replaceAll("\\", "/")
	return [...affectedPaths].some(
		(affected) =>
			normalized === affected ||
			normalized.endsWith(`/${affected}`) ||
			affected.startsWith(`${normalized}/`) ||
			normalized.startsWith(`${affected}/`),
	)
}

function candidateEvidence(context: CompiledCouncilContext): EvidenceArtifact[] {
	const candidate = context.artifacts.find(
		(artifact): artifact is CandidatePatchArtifact => artifact.kind === "candidate_patch",
	)
	if (!candidate) {
		const objective = context.artifacts.find(({ artifact_id }) => artifact_id === context.objective.artifact_id)
		const turnStart = objective?.message_index ?? 0
		return context.artifacts.filter(
			(artifact) =>
				(artifact.kind === "tool_call" || artifact.kind === "tool_result") &&
				artifact.message_index !== null &&
				artifact.message_index >= turnStart,
		)
	}
	const affectedPaths = new Set(
		candidate.candidate_patch.operations.flatMap((operation) => [
			operation.path,
			...(operation.from_path ? [operation.from_path] : []),
		]),
	)
	const resultIds = new Set(
		context.artifacts
			.filter(
				(artifact): artifact is ToolResultArtifact =>
					artifact.kind === "tool_result" &&
					(matchesAffectedPath(artifact.tool_result.metadata.path, affectedPaths) ||
						artifact.tool_result.metadata.test !== undefined),
			)
			.map(({ tool_result }) => tool_result.id),
	)
	return context.artifacts.filter(
		(artifact) =>
			artifact.kind === "candidate_patch" ||
			artifact.kind === "candidate_validation" ||
			(artifact.kind === "tool_result" && resultIds.has(artifact.tool_result.id)) ||
			(artifact.kind === "tool_call" && resultIds.has(artifact.tool_call.id)),
	)
}

export function buildRoleContext(
	context: CompiledCouncilContext,
	role: "independent",
	validationCatalog?: ValidationCatalogEntry[],
): IndependentRoleContext
export function buildRoleContext(
	context: CompiledCouncilContext,
	role: "critic",
	validationCatalog?: ValidationCatalogEntry[],
): CriticRoleContext
export function buildRoleContext(
	context: CompiledCouncilContext,
	role: "checker",
	validationCatalog?: ValidationCatalogEntry[],
): CheckerRoleContext
export function buildRoleContext(
	context: CompiledCouncilContext,
	role: ReviewerRole,
	validationCatalog?: ValidationCatalogEntry[],
): RoleContextArtifact
export function buildRoleContext(
	context: CompiledCouncilContext,
	role: ReviewerRole,
	validationCatalog: ValidationCatalogEntry[] = [],
): RoleContextArtifact {
	const common = {
		schema_version: 1 as const,
		run_id: context.run_id,
		objective: context.objective,
		requirements: councilRequirements(context),
		constraints: councilConstraints(context),
		evidence: role === "independent" ? independentEvidence(context) : context.artifacts,
		truncation: context.truncation,
	}
	if (role === "independent") return { ...common, role }
	if (!context.lead_draft) {
		throw new ContextCompilerError("invalid_context", `${role} review requires a lead draft`)
	}
	const evidence = candidateEvidence(context)
	if (role === "critic") return { ...common, role, evidence, lead_draft: context.lead_draft }
	return { ...common, role, evidence, validation_catalog: validationCatalog }
}

export function fitCouncilContextToModel(
	compiled: CompiledCouncilContext,
	role: ReviewerRole,
	limits: ModelContextLimits,
	validationCatalog: ValidationCatalogEntry[] = [],
): FittedRoleContext {
	const safetyMargin = limits.safetyMargin ?? DEFAULT_CONTEXT_SAFETY_MARGIN
	const overheadTokens = limits.overheadTokens ?? DEFAULT_CONTEXT_OVERHEAD_TOKENS
	const safeWindow = Math.floor(limits.model.contextWindow * safetyMargin)
	const requestedOutput = Math.max(1, Math.floor(limits.requestedMaxOutputTokens))
	const maximumInputTokens =
		safeWindow - Math.min(requestedOutput, Math.max(1, safeWindow - overheadTokens - 1)) - overheadTokens
	if (maximumInputTokens <= 0)
		throw new ContextCompilerError("context_limit", "Physical model context window is too small")
	const fitted = boundCompiledContext(compiled, maximumInputTokens * 4)
	const roleContext = buildRoleContext(fitted, role, validationCatalog)
	const inputTokens = estimatedTokens(roleContext) + overheadTokens
	const maxOutputTokens = Math.min(requestedOutput, safeWindow - inputTokens)
	if (maxOutputTokens <= 0)
		throw new ContextCompilerError("context_limit", "Council role context exceeds the model window")
	return {
		context: roleContext,
		modelRef: `${limits.model.provider}/${limits.model.id}`,
		estimatedInputTokens: inputTokens,
		maxOutputTokens,
		truncated: fitted.truncation.truncated,
	}
}

export function fitContextToModel(
	context: Context,
	limits: ModelContextLimits,
	inputTokenHint?: number,
): FittedPiContext {
	const safetyMargin = limits.safetyMargin ?? DEFAULT_CONTEXT_SAFETY_MARGIN
	const overheadTokens = limits.overheadTokens ?? DEFAULT_CONTEXT_OVERHEAD_TOKENS
	const safeWindow = Math.floor(limits.model.contextWindow * safetyMargin)
	const requestedOutput = Math.max(1, Math.floor(limits.requestedMaxOutputTokens))
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
	const maxOutputTokens = Math.min(requestedOutput, safeWindow - inputTokens)
	if (maxOutputTokens <= 0) throw new ContextCompilerError("context_limit", "Council context exceeds the model window")
	return {
		context: messages === context.messages ? context : { ...context, messages },
		modelRef: `${limits.model.provider}/${limits.model.id}`,
		estimatedInputTokens: inputTokens,
		maxOutputTokens,
		truncated,
	}
}

export function toolCallArguments(call: ToolCall): JsonObject {
	return toJsonObject(call.arguments)
}
