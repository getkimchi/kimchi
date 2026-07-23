import { createHash } from "node:crypto"
import { z } from "zod"
import { REQUIRED_REVIEWER_ROLES, type ReviewerRole } from "./types.js"

export type { ReviewerRole } from "./types.js"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
	[key: string]: JsonValue
}

export type TrustClassification =
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
	exit?: { code: number | null; signal?: string }
	test?: {
		status: "passed" | "failed" | "skipped" | "unknown"
		passed?: number
		failed?: number
		skipped?: number
	}
	error?: { message: string; code?: string }
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

export interface CandidateValidationArtifact extends EvidenceArtifactBase {
	kind: "candidate_validation"
	trust: "untrusted_tool_output"
	candidate_validation: {
		checks: Array<{
			name: string
			status: "passed" | "failed" | "not_run"
			detail: string
		}>
		limitations: string[]
	}
}

export type EvidenceArtifact =
	| SystemInstructionArtifact
	| UserTextArtifact
	| AssistantTextArtifact
	| ToolCallArtifact
	| ToolResultArtifact
	| CandidatePatchArtifact
	| CandidateValidationArtifact

export type ReviewDecision = "accept" | "revise" | "needs_evidence"
export type FindingSeverity = "critical" | "high" | "medium" | "low"

const nonEmptyString = (maximum: number) =>
	z
		.string()
		.max(maximum)
		.refine((value) => value.trim().length > 0, "must not be blank")
const boundedStringList = (maximumItems = 20, maximumLength = 4096) =>
	z.array(z.string().max(maximumLength)).max(maximumItems)

const DecisionSchema = z.enum(["accept", "revise", "needs_evidence"])
const SeveritySchema = z.enum(["critical", "high", "medium", "low"])

const RawFindingSchema = z
	.object({
		severity: SeveritySchema,
		statement: nonEmptyString(2048),
		evidence_refs: boundedStringList(12, 256),
		assumptions: boundedStringList(8, 1024),
		suggested_check: z.string().max(1024),
	})
	.strict()

export const CouncilFindingSchema = RawFindingSchema.extend({
	id: z.string().regex(/^finding_(?:independent|critic|checker)_[a-f0-9]{16}$/),
}).strict()

export type CouncilFinding = z.infer<typeof CouncilFindingSchema>

const commonRawReviewShape = {
	schema_version: z.literal(1),
	decision: DecisionSchema,
	findings: z.array(RawFindingSchema).max(8),
	recommended_changes: boundedStringList(8, 2048),
	missing_evidence: boundedStringList(8, 2048),
}

const commonReviewShape = {
	schema_version: z.literal(1),
	decision: DecisionSchema,
	findings: z.array(CouncilFindingSchema).max(8),
	recommended_changes: boundedStringList(8, 2048),
	missing_evidence: boundedStringList(8, 2048),
}

const RequirementCheckSchema = z
	.object({
		requirement: nonEmptyString(2048),
		status: z.enum(["satisfied", "unsatisfied", "not_proven"]),
		evidence_refs: boundedStringList(12, 256),
	})
	.strict()

export const IndependentReviewOutputSchema = z
	.object({
		...commonRawReviewShape,
		role: z.literal("independent"),
		independent_solution: nonEmptyString(8192),
		key_claims: boundedStringList(8, 2048),
		assumptions: boundedStringList(8, 2048),
		risks: boundedStringList(8, 2048),
		required_checks: boundedStringList(5, 2048),
	})
	.strict()

export const CriticReviewOutputSchema = z
	.object({
		...commonRawReviewShape,
		role: z.literal("critic"),
		challenged_assumptions: boundedStringList(8, 2048),
		counterexamples: boundedStringList(8, 2048),
		affected_claims: boundedStringList(8, 2048),
	})
	.strict()

export const CheckerReviewOutputSchema = z
	.object({
		...commonRawReviewShape,
		role: z.literal("checker"),
		requirement_checks: z.array(RequirementCheckSchema).max(20),
	})
	.strict()

export const IndependentReviewArtifactSchema = z
	.object({
		...commonReviewShape,
		role: z.literal("independent"),
		independent_solution: nonEmptyString(8192),
		key_claims: boundedStringList(8, 2048),
		assumptions: boundedStringList(8, 2048),
		risks: boundedStringList(8, 2048),
		required_checks: boundedStringList(5, 2048),
	})
	.strict()

export const CriticReviewArtifactSchema = z
	.object({
		...commonReviewShape,
		role: z.literal("critic"),
		challenged_assumptions: boundedStringList(8, 2048),
		counterexamples: boundedStringList(8, 2048),
		affected_claims: boundedStringList(8, 2048),
	})
	.strict()

export const CheckerReviewArtifactSchema = z
	.object({
		...commonReviewShape,
		role: z.literal("checker"),
		requirement_checks: z.array(RequirementCheckSchema).max(20),
	})
	.strict()

export type IndependentReviewArtifact = z.infer<typeof IndependentReviewArtifactSchema>
export type CriticReviewArtifact = z.infer<typeof CriticReviewArtifactSchema>
export type CheckerReviewArtifact = z.infer<typeof CheckerReviewArtifactSchema>
export type ReviewArtifact = IndependentReviewArtifact | CriticReviewArtifact | CheckerReviewArtifact

export const FindingDispositionSchema = z
	.object({
		finding_id: CouncilFindingSchema.shape.id,
		disposition: z.enum(["upheld", "resolved", "needs_evidence"]),
		rationale: nonEmptyString(2048),
		evidence_refs: boundedStringList(12, 256),
		revision_instruction: z.string().max(2048).nullable(),
		required_check: z.string().max(2048).nullable(),
	})
	.strict()

export const JudgeArtifactSchema = z
	.object({
		schema_version: z.literal(1),
		decision: DecisionSchema,
		dispositions: z.array(FindingDispositionSchema).max(24),
		consensus: boundedStringList(8, 2048),
		contradictions: boundedStringList(8, 2048),
		partial_coverage: boundedStringList(8, 2048),
		unique_insights: boundedStringList(8, 2048),
		blind_spots: boundedStringList(8, 2048),
		unsupported_claims: boundedStringList(8, 2048),
		required_checks: z.array(nonEmptyString(64)).max(3),
		revision_instructions: boundedStringList(8, 2048),
		agreement: z.enum(["low", "medium", "high"]),
	})
	.strict()

export type FindingDisposition = z.infer<typeof FindingDispositionSchema>
export type JudgeArtifact = z.infer<typeof JudgeArtifactSchema>

const FinalCheckResolutionSchema = z
	.object({
		obligation_id: nonEmptyString(128),
		status: z.enum(["resolved", "unresolved", "needs_evidence"]),
		rationale: nonEmptyString(2048),
		evidence_refs: boundedStringList(12, 256),
	})
	.strict()

export const FinalCheckOutputSchema = z
	.object({
		schema_version: z.literal(1),
		role: z.literal("checker"),
		decision: z.enum(["accept", "reject", "needs_evidence"]),
		patch_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		resolutions: z.array(FinalCheckResolutionSchema).max(40),
	})
	.strict()

export type FinalCheckArtifact = z.infer<typeof FinalCheckOutputSchema>

export type CouncilSchemaErrorCode =
	| "missing_json"
	| "ambiguous_json"
	| "invalid_json"
	| "invalid_shape"
	| "unsupported_reference"
	| "missing_disposition"

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

export function parseDeterministicJson(raw: string): Record<string, unknown> {
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

function canonicalString(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ")
}

export function stableFindingId(role: ReviewerRole, finding: Omit<CouncilFinding, "id">): string {
	const canonical = {
		role,
		severity: finding.severity,
		statement: canonicalString(finding.statement),
		evidence_refs: [...finding.evidence_refs].map(canonicalString).sort(),
		assumptions: [...finding.assumptions].map(canonicalString).sort(),
		suggested_check: canonicalString(finding.suggested_check),
	}
	const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)
	return `finding_${role}_${digest}`
}

function invalidShape(error: z.ZodError): never {
	throw new CouncilSchemaError("invalid_shape", z.prettifyError(error), { cause: error })
}

function validateEvidenceReferences(references: Iterable<string>, allowed: Set<string>): void {
	for (const reference of references) {
		if (!allowed.has(reference)) {
			throw new CouncilSchemaError("unsupported_reference", `Unsupported evidence reference: ${reference}`)
		}
	}
}

export function parseReviewArtifact(
	raw: string,
	role: ReviewerRole,
	allowedEvidenceIds: Iterable<string>,
	expectedRequirementIds: Iterable<string> = [],
): ReviewArtifact {
	const value = parseDeterministicJson(raw)
	const parsed =
		role === "independent"
			? IndependentReviewOutputSchema.safeParse(value)
			: role === "critic"
				? CriticReviewOutputSchema.safeParse(value)
				: CheckerReviewOutputSchema.safeParse(value)
	if (!parsed.success) invalidShape(parsed.error)
	const allowed = new Set(allowedEvidenceIds)
	for (const finding of parsed.data.findings) validateEvidenceReferences(finding.evidence_refs, allowed)
	if (parsed.data.role === "checker") {
		const expected = new Set(expectedRequirementIds)
		const seen = new Set<string>()
		for (const check of parsed.data.requirement_checks) {
			validateEvidenceReferences(check.evidence_refs, allowed)
			if (!expected.has(check.requirement)) {
				throw new CouncilSchemaError(
					"unsupported_reference",
					`Requirement check references an unsupported requirement: ${check.requirement}`,
				)
			}
			if (seen.has(check.requirement)) {
				throw new CouncilSchemaError("invalid_shape", `Requirement check is duplicated: ${check.requirement}`)
			}
			seen.add(check.requirement)
		}
		const missing = [...expected].filter((requirementId) => !seen.has(requirementId))
		if (missing.length > 0) {
			throw new CouncilSchemaError("invalid_shape", `Requirement checks are missing: ${missing.join(", ")}`)
		}
	}
	const findings = parsed.data.findings.map((finding) => ({ ...finding, id: stableFindingId(role, finding) }))
	if (new Set(findings.map(({ id }) => id)).size !== findings.length) {
		throw new CouncilSchemaError("invalid_shape", "Council review contains duplicate findings")
	}
	const artifact = { ...parsed.data, findings }
	const validated =
		artifact.role === "independent"
			? IndependentReviewArtifactSchema.safeParse(artifact)
			: artifact.role === "critic"
				? CriticReviewArtifactSchema.safeParse(artifact)
				: CheckerReviewArtifactSchema.safeParse(artifact)
	if (!validated.success) invalidShape(validated.error)
	return validated.data
}

export function parseJudgeArtifact(
	raw: string,
	findings: readonly CouncilFinding[],
	allowedEvidenceIds: Iterable<string>,
	allowedValidationCheckIds?: Iterable<string>,
): JudgeArtifact {
	const parsed = JudgeArtifactSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	const expected = new Set(findings.map(({ id }) => id))
	const seen = new Set<string>()
	const allowed = new Set(allowedEvidenceIds)
	for (const disposition of parsed.data.dispositions) {
		if (!expected.has(disposition.finding_id)) {
			throw new CouncilSchemaError(
				"unsupported_reference",
				`Disposition references an unsupported finding: ${disposition.finding_id}`,
			)
		}
		if (seen.has(disposition.finding_id)) {
			throw new CouncilSchemaError("invalid_shape", `Duplicate disposition: ${disposition.finding_id}`)
		}
		seen.add(disposition.finding_id)
		validateEvidenceReferences(disposition.evidence_refs, allowed)
		if (disposition.disposition === "resolved") {
			if (
				disposition.evidence_refs.length === 0 ||
				disposition.revision_instruction !== null ||
				disposition.required_check !== null
			) {
				throw new CouncilSchemaError("invalid_shape", "Resolved findings require evidence and no follow-up action")
			}
		}
		if (disposition.disposition === "upheld") {
			if (!disposition.revision_instruction?.trim() || disposition.required_check !== null) {
				throw new CouncilSchemaError("invalid_shape", "Upheld findings require one revision instruction")
			}
		}
		if (disposition.disposition === "needs_evidence") {
			if (!disposition.required_check?.trim() || disposition.revision_instruction !== null) {
				throw new CouncilSchemaError("invalid_shape", "Evidence gaps require one check")
			}
		}
	}
	const missing = [...expected].filter((id) => !seen.has(id))
	if (missing.length > 0) {
		throw new CouncilSchemaError("missing_disposition", `Missing dispositions for: ${missing.join(", ")}`)
	}
	const hasEvidenceGap = parsed.data.dispositions.some(({ disposition }) => disposition === "needs_evidence")
	const hasUpheld = parsed.data.dispositions.some(({ disposition }) => disposition === "upheld")
	const expectedDecision: ReviewDecision = hasEvidenceGap ? "needs_evidence" : hasUpheld ? "revise" : "accept"
	if (parsed.data.decision !== expectedDecision) {
		throw new CouncilSchemaError(
			"invalid_shape",
			`Judge decision ${parsed.data.decision} conflicts with dispositions; expected ${expectedDecision}`,
		)
	}
	if (allowedValidationCheckIds !== undefined) {
		const allowedChecks = new Set(allowedValidationCheckIds)
		if (parsed.data.required_checks.length === 0) {
			throw new CouncilSchemaError("invalid_shape", "Council judge omitted the deterministic validation selection")
		}
		for (const checkId of parsed.data.required_checks) {
			if (!allowedChecks.has(checkId)) {
				throw new CouncilSchemaError("unsupported_reference", `Unsupported validation check ID: ${checkId}`)
			}
		}
	}
	return parsed.data
}

export function parseFinalCheckArtifact(
	raw: string,
	expectedPatchSha256: string,
	expectedObligationIds: Iterable<string>,
	allowedEvidenceIds: Iterable<string>,
): FinalCheckArtifact {
	const parsed = FinalCheckOutputSchema.safeParse(parseDeterministicJson(raw))
	if (!parsed.success) invalidShape(parsed.error)
	if (parsed.data.patch_sha256 !== expectedPatchSha256) {
		throw new CouncilSchemaError("invalid_shape", "Council final checker returned a different patch hash")
	}
	const expected = new Set(expectedObligationIds)
	const seen = new Set<string>()
	const allowed = new Set(allowedEvidenceIds)
	let allResolved = true
	for (const resolution of parsed.data.resolutions) {
		if (!expected.has(resolution.obligation_id) || seen.has(resolution.obligation_id)) {
			throw new CouncilSchemaError("invalid_shape", "Council final checker returned invalid obligation coverage")
		}
		seen.add(resolution.obligation_id)
		if (resolution.status === "resolved" && resolution.evidence_refs.length === 0) {
			throw new CouncilSchemaError("invalid_shape", "Council final checker resolved an obligation without evidence")
		}
		if (resolution.status !== "resolved") allResolved = false
		validateEvidenceReferences(resolution.evidence_refs, allowed)
	}
	if (seen.size !== expected.size) {
		throw new CouncilSchemaError("invalid_shape", "Council final checker did not resolve every obligation")
	}
	if ((parsed.data.decision === "accept") !== allResolved) {
		throw new CouncilSchemaError(
			"invalid_shape",
			"Council final checker decision conflicts with obligation resolutions",
		)
	}
	return parsed.data
}

export function isReviewerRole(value: string): value is ReviewerRole {
	return (REQUIRED_REVIEWER_ROLES as readonly string[]).includes(value)
}
