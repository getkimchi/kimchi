import {
	DEFAULT_WRITER_LIMIT,
	normalizeFindingInput,
	REPLY_LIMIT,
	type ReviewFindingRecord,
	type ReviewSubmitContext,
	validateReviewFindingInput,
	validateReviewReplyInput,
} from "../review-submit/store.js"
import { buildReconciledCheckpoint, orderedCandidates, serializeFinalFindings } from "./output.js"
import {
	REVIEW_RECONCILIATION_VERSION,
	type ReconciliationDecision,
	type ReconciliationFinding,
	type ReconciliationThread,
	type ReviewPanelCandidate,
	type SemanticReconciliation,
} from "./types.js"

export class ReconciliationInvocationError extends Error {
	override readonly name = "ReconciliationInvocationError"
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!object(value)) throw new Error(`${label} must be an object.`)
	return value
}

function requireArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
	return value
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value) || value.includes("\0")) {
		throw new Error(`${label} must be a${allowEmpty ? "" : " non-empty"} string without NUL.`)
	}
	return value
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`)
	}
}

export function parseSemanticReconciliation(responseText: string): unknown {
	// One complete Markdown fence is transport formatting. Explanatory prose,
	// additional fences, or a second JSON value still select the deterministic fallback.
	const trimmed = responseText.trim()
	const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
	return JSON.parse(fenced?.[1] ?? trimmed)
}

export interface ValidatedReconciliation {
	semantic: SemanticReconciliation
	findings: ReviewFindingRecord[]
	provenance: Record<string, string[]>
	provenanceTruncatedCount: number
}

export async function validateSemanticReconciliation(
	value: unknown,
	candidates: readonly ReviewPanelCandidate[],
	context: ReviewSubmitContext,
): Promise<ValidatedReconciliation> {
	const root = requireObject(value, "Reconciliation")
	requireKeys(root, ["schema_version", "findings", "decisions", "threads"], "Reconciliation")
	if (root.schema_version !== REVIEW_RECONCILIATION_VERSION) {
		throw new Error(`Reconciliation must use ${REVIEW_RECONCILIATION_VERSION}.`)
	}
	const rawFindings = requireArray(root.findings, "Reconciliation findings")
	const rawDecisions = requireArray(root.decisions, "Reconciliation decisions")
	const rawThreads = requireArray(root.threads, "Reconciliation threads")
	if (rawFindings.length > DEFAULT_WRITER_LIMIT) throw new Error("Reconciliation exceeds the 50-finding limit.")
	if (rawDecisions.length !== candidates.length) {
		throw new Error(`Reconciliation must account for all ${candidates.length} candidates exactly once.`)
	}
	if (rawThreads.length > REPLY_LIMIT) throw new Error("Reconciliation exceeds the 30-reply limit.")

	const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
	const decisions = new Map<string, ReconciliationDecision>()
	for (const [index, value] of rawDecisions.entries()) {
		const raw = requireObject(value, `decisions[${index}]`)
		requireKeys(raw, ["candidate_id", "disposition", "finding", "reason"], `decisions[${index}]`)
		const candidateId = requireString(raw.candidate_id, `decisions[${index}].candidate_id`)
		if (!candidateById.has(candidateId)) throw new Error(`Unknown reconciliation candidate ${candidateId}.`)
		if (decisions.has(candidateId))
			throw new Error(`Candidate ${candidateId} has more than one reconciliation decision.`)
		if (raw.disposition !== "retained" && raw.disposition !== "merged" && raw.disposition !== "rejected") {
			throw new Error(`Candidate ${candidateId} has an unsupported disposition.`)
		}
		const reason = requireString(raw.reason, `decisions[${index}].reason`)
		if (Buffer.byteLength(reason, "utf8") > 2048) throw new Error(`Candidate ${candidateId} has an oversized reason.`)
		if (raw.disposition === "rejected" && raw.finding !== undefined) {
			throw new Error(`Rejected candidate ${candidateId} cannot reference a finding.`)
		}
		if (raw.disposition !== "rejected" && raw.finding === undefined) {
			throw new Error(`Retained or merged candidate ${candidateId} must reference a finding.`)
		}
		decisions.set(candidateId, {
			candidate_id: candidateId,
			disposition: raw.disposition,
			...(raw.finding === undefined ? {} : { finding: requireString(raw.finding, `decisions[${index}].finding`) }),
			reason,
		})
	}
	if (decisions.size !== candidates.length) throw new Error("Reconciliation omitted one or more candidates.")

	const groups: Array<{ candidates: ReviewPanelCandidate[]; finding: ReconciliationFinding }> = []
	const semanticFindings: ReconciliationFinding[] = []
	const findingGroups = new Map<string, ReconciliationFinding>()
	for (const [index, value] of rawFindings.entries()) {
		const raw = requireObject(value, `findings[${index}]`)
		requireKeys(
			raw,
			["id", "path", "line", "title", "description", "explanation", "suggestion", "priority", "type", "candidate_ids"],
			`findings[${index}]`,
		)
		const id = requireString(raw.id, `findings[${index}].id`)
		if (findingGroups.has(id)) throw new Error(`Duplicate reconciliation finding ID ${id}.`)
		const candidateIds = requireArray(raw.candidate_ids, `findings[${index}].candidate_ids`).map(
			(candidate, position) => requireString(candidate, `findings[${index}].candidate_ids[${position}]`),
		)
		if (candidateIds.length === 0 || new Set(candidateIds).size !== candidateIds.length) {
			throw new Error(`Finding ${id} must reference each source candidate once and cannot be empty.`)
		}
		const input = {
			path: requireString(raw.path, `findings[${index}].path`),
			line: raw.line as number,
			title: requireString(raw.title, `findings[${index}].title`),
			description: requireString(raw.description, `findings[${index}].description`),
			explanation: requireString(raw.explanation, `findings[${index}].explanation`),
			suggestion: requireString(raw.suggestion, `findings[${index}].suggestion`),
			priority: raw.priority as ReconciliationFinding["priority"],
			type: raw.type as ReconciliationFinding["type"],
		}
		const invalid = await validateReviewFindingInput(input, context)
		if (invalid) throw new Error(`Finding ${id} failed field or anchor validation: ${invalid.message}`)
		const finding: ReconciliationFinding = {
			id,
			...normalizeFindingInput(input),
			candidate_ids: candidateIds,
		}
		findingGroups.set(id, finding)
		const groupCandidates = candidateIds.map((candidateId) => {
			const candidate = candidateById.get(candidateId)
			if (!candidate) throw new Error(`Finding ${id} references unknown candidate ${candidateId}.`)
			const decision = decisions.get(candidateId)
			if (!decision || decision.finding !== id || decision.disposition === "rejected") {
				throw new Error(`Finding ${id} and the decision for ${candidateId} disagree.`)
			}
			if (candidateIds.length === 1 && decision.disposition !== "retained") {
				throw new Error(`Single-candidate finding ${id} must retain ${candidateId}.`)
			}
			if (candidateIds.length > 1 && decision.disposition !== "merged") {
				throw new Error(`Multi-candidate finding ${id} must mark ${candidateId} merged.`)
			}
			return candidate
		})
		const orderedSources = orderedCandidates(groupCandidates)
		const preservedFields = ["path", "line", "description", "explanation", "suggestion", "type"] as const
		const source = orderedSources.find((candidate) =>
			preservedFields.every((field) => candidate.finding[field] === finding[field]),
		)
		if (!source) {
			throw new Error(
				`Finding ${id} may rewrite only title and priority; after input normalization, path, line, description, explanation, suggestion, and type must match one best-supported source candidate.`,
			)
		}
		semanticFindings.push(finding)
		groups.push({ candidates: orderedSources, finding })
	}
	for (const [candidateId, decision] of decisions) {
		if (decision.disposition === "rejected") continue
		const group = findingGroups.get(decision.finding ?? "")
		if (!group) throw new Error(`Candidate ${candidateId} references missing finding ${decision.finding}.`)
		if (!group.candidate_ids.includes(candidateId)) {
			throw new Error(
				`Candidate ${candidateId} references finding ${group.id} but is omitted from its candidate_ids; decisions and group membership must agree bidirectionally.`,
			)
		}
	}

	const threads: ReconciliationThread[] = []
	const threadIds = new Set<string>()
	for (const [index, value] of rawThreads.entries()) {
		const raw = requireObject(value, `threads[${index}]`)
		requireKeys(
			raw,
			["thread_id", "body", "action", "verdict", "evidence_kind", "evidence", "equivalent_candidate_ids"],
			`threads[${index}]`,
		)
		const threadId = requireString(raw.thread_id, `threads[${index}].thread_id`)
		if (threadIds.has(threadId)) throw new Error(`Reconciliation contains duplicate thread ${threadId}.`)
		threadIds.add(threadId)
		const equivalent = requireArray(
			raw.equivalent_candidate_ids ?? [],
			`threads[${index}].equivalent_candidate_ids`,
		).map((candidate, position) => requireString(candidate, `threads[${index}].equivalent_candidate_ids[${position}]`))
		if (new Set(equivalent).size !== equivalent.length)
			throw new Error(`Thread ${threadId} repeats an equivalent candidate.`)
		for (const candidateId of equivalent) {
			if (!candidateById.has(candidateId))
				throw new Error(`Thread ${threadId} references unknown candidate ${candidateId}.`)
			if (decisions.get(candidateId)?.disposition !== "rejected") {
				throw new Error(`Equivalent candidate ${candidateId} must be rejected to avoid reposting an earlier finding.`)
			}
		}
		const reply = {
			thread_id: threadId,
			body: raw.body,
			action: raw.action,
			...(raw.verdict === undefined ? {} : { verdict: raw.verdict }),
			...(raw.evidence_kind === undefined ? {} : { evidence_kind: raw.evidence_kind }),
			...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
		} as ReconciliationThread
		const invalid = await validateReviewReplyInput(reply, context)
		if (invalid) throw new Error(`Thread ${threadId} is not an allowed reply: ${invalid.message}`)
		threads.push({ ...reply, equivalent_candidate_ids: equivalent })
	}

	const semantic: SemanticReconciliation = {
		schema_version: REVIEW_RECONCILIATION_VERSION,
		findings: semanticFindings,
		decisions: [...decisions.values()],
		threads,
	}
	const packed = buildReconciledCheckpoint(groups)
	const findings = packed.records
	if (findings.length !== groups.length) {
		throw new Error("Reconciled findings exceed the shared 1 MiB output limit.")
	}
	// Serialize once here as a size/schema guard; the coordinator performs the
	// actual atomic write after finding and summary state have been computed.
	serializeFinalFindings(findings)
	return {
		semantic,
		findings,
		provenance: packed.provenance,
		provenanceTruncatedCount: packed.provenanceTruncatedCount,
	}
}
