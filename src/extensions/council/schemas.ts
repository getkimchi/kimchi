import type { Usage } from "@earendil-works/pi-ai"
import { z } from "zod"
import type { ChangeSetStats, ChangeTransactionState } from "../../agent-patch/index.js"
import { type CandidatePatch, CandidatePatchSchema } from "./patch.js"
import type { ValidationCheckKind, ValidationMutationPolicy } from "./validation.js"

export const MAX_COUNCIL_PANEL_SIZE = 5
export type CouncilStage = "lead" | "solver" | "analyst" | "synthesis" | "combined" | "repair"
export type CouncilRole = CouncilStage
export type CouncilSchemaErrorCode =
	| "missing_json"
	| "ambiguous_json"
	| "invalid_json"
	| "invalid_shape"
	| "unsupported_reference"
type CouncilOutcome = "accepted" | "tool_use" | "degraded" | "error" | "aborted"
export type CouncilTransactionProgressPhase =
	| "exploring"
	| "solving"
	| "comparing"
	| "writing"
	| "applying"
	| "checking"
export type SafeCouncilFailureReason =
	| "cancelled"
	| "timed_out"
	| "panel_unavailable"
	| "validation_failed"
	| "limit_reached"

export type CouncilProgressEvent =
	| {
			type: "run_started"
			runId: string
			preset: "fast" | "normal" | "deep"
			startedAt: number
	  }
	| {
			type: "stage_started"
			runId: string
			stageId: string
			role: CouncilRole
			startedAt: number
	  }
	| {
			type: "stage_completed"
			runId: string
			stageId: string
			role: CouncilRole
			durationMs: number
	  }
	| {
			type: "stage_failed"
			runId: string
			stageId: string
			role: CouncilRole
			durationMs: number
			reason: SafeCouncilFailureReason
	  }
	| {
			type: "transaction_progress"
			runId: string
			phase: CouncilTransactionProgressPhase
	  }
	| {
			type: "run_completed"
			runId: string
			outcome: "accepted" | "tool_use" | "degraded"
			durationMs: number
			estimatedCostUsd?: number
	  }
	| {
			type: "run_failed" | "run_aborted"
			runId: string
			durationMs: number
			reason: SafeCouncilFailureReason
	  }
export type CouncilDegradedReason =
	| "panel_unavailable"
	| "self_fusion"
	| "structured_output_invalid"
	| "budget_exhausted"
	| "deadline_exceeded"
	| "insufficient_evidence"
	| "analyst_failed"
	| "budget_exceeded"
	| "structured_output_failed"
	| "synthesis_failed"
	| "context_compilation_failed"
	| "no_validation_checks"
	| "no_changes_needed"

export interface CouncilModelPool {
	primary: string
	fallbacks: string[]
}

interface CouncilBudgetLimits {
	maxLogicalCalls: number
	maxPhysicalAttempts: number
	maxConcurrentCalls: number
	maxAggregateInputTokens: number
	maxAggregateOutputTokens: number
	maxRetriesPerCall: number
}

export interface CouncilConfig {
	enabled: boolean
	lead: CouncilModelPool
	panel: CouncilModelPool[]
	analyst: CouncilModelPool
	panelSize: number
	panelSizeOverride?: number
	overallTimeoutMs: number
	stageTimeoutMs: number
	leadMaxTokens: number
	internalMaxTokens: number
	maxEvidenceBytes: number
	maxStructuredBytes: number
	budget: CouncilBudgetLimits
}

export interface CouncilBudgetUsage {
	logicalCalls: number
	physicalAttempts: number
	maxObservedConcurrency: number
	aggregateInputTokens: number
	aggregateOutputTokens: number
	evidenceBytes: number
	structuredBytes: number
	cacheHits: number
	cacheMisses: number
}

export interface CouncilStageRecord {
	stage: CouncilStage
	modelRef: string
	status: "ok" | "degraded" | "error" | "aborted"
	durationMs: number
	attempts: number
	usage?: Usage
	error?: string
	schemaErrorCode?: CouncilSchemaErrorCode
	truncated?: boolean
	retry?: boolean
	fallback?: boolean
	cacheHit?: boolean
}

export interface CouncilTransactionSnapshot {
	transactionId: string
	state: ChangeTransactionState
	outcome: "pending" | "applied" | "discarded" | "rolled_back" | "failed" | "hard_recovery"
	patchSha256?: string
	stats?: ChangeSetStats
	baseVerification: "not_run" | "passed" | "failed"
	selectedValidationCheckIds: string[]
	postApplyChecks: Array<{
		id: string
		kind: ValidationCheckKind
		toolName: string
		command: string
		ok: boolean
		exitCode: number | null
		durationMs: number
		beforeSha256: string
		afterSha256?: string
		mutationPolicy: ValidationMutationPolicy
		mutation: "none" | "expected_only" | "unexpected_restored" | "unexpected_restore_failed"
	}>
	rollbackState: "not_available" | "available" | "completed" | "failed"
	hardRecoveryRequired: boolean
}

export interface CouncilRunRecord {
	runId: string
	virtualModel: string
	outcome: CouncilOutcome
	degradedReason?: CouncilDegradedReason
	durationMs: number
	stages: CouncilStageRecord[]
	usage: Usage
	budget: CouncilBudgetUsage
	transaction?: CouncilTransactionSnapshot
}

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
	[key: string]: JsonValue
}

type TrustClassification =
	| "trusted_system_instruction"
	| "trusted_user_instruction"
	| "untrusted_assistant_output"
	| "untrusted_tool_output"

interface EvidenceArtifactBase {
	artifact_id: string
	sequence: number
	message_index: number | null
	block_index: number | null
	trust: TrustClassification
	truncated?: boolean
}

export interface SystemInstructionArtifact extends EvidenceArtifactBase {
	kind: "system_instruction"
	trust: "trusted_system_instruction"
	text: string
}

export interface UserTextArtifact extends EvidenceArtifactBase {
	kind: "user_text"
	trust: "trusted_user_instruction"
	text: string
}

export interface AssistantTextArtifact extends EvidenceArtifactBase {
	kind: "assistant_text"
	trust: "untrusted_assistant_output"
	text: string
}

export interface ToolCallArtifact extends EvidenceArtifactBase {
	kind: "tool_call"
	trust: "untrusted_assistant_output"
	tool_call: {
		id: string
		name: string
		arguments: JsonObject
	}
}

export type EvidenceContent = { type: "text"; text: string } | { type: "image"; mime_type: string }

export interface ToolResultMetadata {
	path?: string
	command?: string
}

export interface ToolResultArtifact extends EvidenceArtifactBase {
	kind: "tool_result"
	trust: "untrusted_tool_output"
	tool_result: {
		id: string
		name: string
		is_error: boolean
		content: EvidenceContent[]
		metadata: ToolResultMetadata
	}
}

export interface CandidatePatchArtifact extends EvidenceArtifactBase {
	kind: "candidate_patch"
	trust: "untrusted_assistant_output"
	candidate_patch: {
		transaction_id: string
		patch_sha256: string
		operations: Array<{
			kind: "create" | "update" | "delete" | "rename"
			path: string
			from_path?: string
			base_sha256?: string
		}>
		stats: {
			files: number
			added_lines: number
			removed_lines: number
			patch_bytes: number
		}
		patch: string
	}
}

export type EvidenceArtifact =
	| SystemInstructionArtifact
	| UserTextArtifact
	| AssistantTextArtifact
	| ToolCallArtifact
	| ToolResultArtifact
	| CandidatePatchArtifact

// Analyst/synthesis prose is an advisory artifact, not the applied patch: shape drift here (extra
// items, an omitted bucket, an unrecognized key, an over-long string) is bounded and truncated
// rather than rejected, so a rich comparison can never sink an otherwise-good candidate patch.
const boundedStringList = (maximumItems: number, maximumLength: number) =>
	z
		.array(z.string())
		.optional()
		.transform((value) => (value ?? []).slice(0, maximumItems).map((item) => item.slice(0, maximumLength)))
const requiredCheckList = (maximumItems: number, maximumLength: number) =>
	z
		.array(z.string())
		.optional()
		.transform((value) =>
			(value ?? [])
				.map((item) => item.trim().slice(0, maximumLength))
				.filter((item) => item.length > 0)
				.slice(0, maximumItems),
		)
const optionalSummary = (maximum: number) =>
	z
		.string()
		.optional()
		.transform((value) => {
			if (value === undefined) return undefined
			const bounded = value.length > maximum ? value.slice(0, maximum) : value
			return bounded.trim().length > 0 ? bounded : undefined
		})

const FUSION_ANALYSIS_LIST_MAX_ITEMS = 20
const FUSION_ANALYSIS_LIST_MAX_LENGTH = 2048

export const FusionAnalysisSchema = z.object({
	consensus: boundedStringList(FUSION_ANALYSIS_LIST_MAX_ITEMS, FUSION_ANALYSIS_LIST_MAX_LENGTH),
	contradictions: boundedStringList(FUSION_ANALYSIS_LIST_MAX_ITEMS, FUSION_ANALYSIS_LIST_MAX_LENGTH),
	partial_coverage: boundedStringList(FUSION_ANALYSIS_LIST_MAX_ITEMS, FUSION_ANALYSIS_LIST_MAX_LENGTH),
	unique_insights: boundedStringList(FUSION_ANALYSIS_LIST_MAX_ITEMS, FUSION_ANALYSIS_LIST_MAX_LENGTH),
	blind_spots: boundedStringList(FUSION_ANALYSIS_LIST_MAX_ITEMS, FUSION_ANALYSIS_LIST_MAX_LENGTH),
	required_checks: requiredCheckList(3, 64),
})

export type FusionAnalysis = z.infer<typeof FusionAnalysisSchema>

export const CombinedFusionSchema = z.object({
	analysis: FusionAnalysisSchema,
	summary: optionalSummary(2048),
	patch: CandidatePatchSchema,
})

export type CombinedFusion = z.infer<typeof CombinedFusionSchema>

export const SynthesisResultSchema = z.object({
	summary: optionalSummary(2048),
	patch: CandidatePatchSchema,
})

export type SynthesisResult = z.infer<typeof SynthesisResultSchema>

// The text-fusion path (panel answers and their synthesis) shares one schema shape: a solver's
// standalone answer and the lead's final synthesized answer are both exactly `{ answer }`, unlike
// the code path where synthesis also carries a separate user-facing summary alongside the patch.
export const COUNCIL_ANSWER_SCHEMA =
	'{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string","description":"Complete standalone answer to the objective"}}}'

export const CouncilAnswerSchema = z.object({ answer: z.string().min(1) }).strict()

export type CouncilAnswer = z.infer<typeof CouncilAnswerSchema>

export function parseCandidatePatch(raw: string): CandidatePatch {
	const parsed = CandidatePatchSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	return parsed.data
}

export function parseSynthesisResult(raw: string): SynthesisResult {
	const parsed = SynthesisResultSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	return parsed.data
}

export function parseCouncilAnswer(raw: string): CouncilAnswer {
	const parsed = CouncilAnswerSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	return parsed.data
}
export class CouncilSchemaError extends Error {
	readonly code: CouncilSchemaErrorCode

	constructor(code: CouncilSchemaErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "CouncilSchemaError"
		this.code = code
	}
}

function balancedObjectSpans(value: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = []
	let start = -1
	let depth = 0
	let inString = false
	let escaped = false
	for (let index = 0; index < value.length; index++) {
		const char = value[index]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			continue
		}
		if (char === "{") {
			if (depth === 0) start = index
			depth++
		} else if (char === "}" && depth > 0) {
			depth--
			if (depth === 0 && start >= 0) {
				spans.push({ start, end: index + 1 })
				start = -1
			}
		}
	}
	return spans
}

function healJson(value: string): string {
	let healed = ""
	let inString = false
	let escaped = false
	for (let index = 0; index < value.length; index++) {
		const char = value[index]
		if (inString) {
			if (!escaped && char.charCodeAt(0) < 0x20) {
				healed += JSON.stringify(char).slice(1, -1)
				continue
			}
			healed += char
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			healed += char
			continue
		}
		if (char === ",") {
			let next = index + 1
			while (/\s/.test(value[next] ?? "")) next++
			if (value[next] === "}" || value[next] === "]") continue
		}
		healed += char
	}
	return healed
}

export function extractJsonObject(raw: string): string {
	const normalized = raw.replace(/^\uFEFF/, "").trim()
	const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	const candidate = fenced?.[1] ?? normalized
	const spans = balancedObjectSpans(candidate)
	if (spans.length === 0) throw new CouncilSchemaError("missing_json", "Council output contains no JSON object")
	if (spans.length > 1) throw new CouncilSchemaError("ambiguous_json", "Council output contains multiple JSON objects")
	const [{ start, end }] = spans
	return healJson(candidate.slice(start, end))
}

function parseDeterministicJson(raw: string): Record<string, unknown> {
	let value: unknown
	try {
		value = JSON.parse(extractJsonObject(raw))
	} catch (error) {
		if (error instanceof CouncilSchemaError) throw error
		throw new CouncilSchemaError("invalid_json", "Council output is not valid JSON", { cause: error })
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CouncilSchemaError("invalid_shape", "Council output must be one JSON object")
	}
	return value as Record<string, unknown>
}

function invalidShape(error: z.ZodError): never {
	throw new CouncilSchemaError("invalid_shape", z.prettifyError(error), { cause: error })
}

// The deterministic catalog is the sole authority on which check IDs may ever execute: the runtime
// resolves an ID to an argv strictly from that catalog, so an ID the analyst invents cannot execute
// even if it slipped through here. Dropping it (instead of failing the whole run) is therefore safe.
function keepCatalogValidationCheckIds(
	requiredChecks: readonly string[],
	allowedValidationCheckIds: Iterable<string>,
): string[] {
	const allowedChecks = new Set(allowedValidationCheckIds)
	return requiredChecks.filter((checkId) => allowedChecks.has(checkId))
}

export function parseFusionAnalysisArtifact(
	raw: string,
	allowedValidationCheckIds: Iterable<string> = [],
): FusionAnalysis {
	const parsed = FusionAnalysisSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	return {
		...parsed.data,
		required_checks: keepCatalogValidationCheckIds(parsed.data.required_checks, allowedValidationCheckIds),
	}
}

export function parseCombinedFusionArtifact(
	raw: string,
	allowedValidationCheckIds: Iterable<string> = [],
): CombinedFusion {
	const parsed = CombinedFusionSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	return {
		...parsed.data,
		analysis: {
			...parsed.data.analysis,
			required_checks: keepCatalogValidationCheckIds(parsed.data.analysis.required_checks, allowedValidationCheckIds),
		},
	}
}
