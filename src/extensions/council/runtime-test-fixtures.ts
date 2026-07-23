import type { Context } from "@earendil-works/pi-ai"
import type { CompletePhysicalModel } from "./physical-invoker.js"
import type { CouncilFinding, ReviewerRole } from "./schemas.js"

function userText(context: Context): string {
	const message = context.messages.at(-1)
	return message?.role === "user" && typeof message.content === "string" ? message.content : ""
}

function parseObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

function reviewerRole(context: Context, payload: Record<string, unknown> | undefined): ReviewerRole | undefined {
	const repairKind = payload?.kind
	if (repairKind === "independent" || repairKind === "critic" || repairKind === "checker") return repairKind
	return context.systemPrompt?.match(/"role":"(independent|critic|checker)"/)?.[1] as ReviewerRole | undefined
}

function strictReview(
	value: Record<string, unknown>,
	role: ReviewerRole,
	evidenceIds: string[],
	requirementIds: string[],
): Record<string, unknown> {
	const requirementChecks =
		role === "checker"
			? requirementIds.map((requirement, index) => {
					const supplied = Array.isArray(value.requirement_checks) ? value.requirement_checks : []
					const exact = supplied.find(
						(check) =>
							check &&
							typeof check === "object" &&
							!Array.isArray(check) &&
							(check as { requirement?: unknown }).requirement === requirement,
					)
					const candidate = exact ?? supplied[index]
					const record =
						candidate && typeof candidate === "object" && !Array.isArray(candidate)
							? (candidate as { status?: unknown; evidence_refs?: unknown })
							: undefined
					return {
						requirement,
						status: ["satisfied", "unsatisfied", "not_proven"].includes(String(record?.status))
							? record?.status
							: "satisfied",
						evidence_refs: Array.isArray(record?.evidence_refs)
							? record.evidence_refs
							: evidenceIds[0]
								? [evidenceIds[0]]
								: [],
					}
				})
			: undefined
	const roleFields =
		role === "independent"
			? {
					independent_solution: "Independent fixture solution",
					key_claims: [],
					assumptions: [],
					risks: [],
					required_checks: [],
				}
			: role === "critic"
				? { challenged_assumptions: [], counterexamples: [], affected_claims: [] }
				: { requirement_checks: requirementChecks }
	if (value.schema_version === 1 && value.role === role) {
		return role === "checker" ? { ...value, ...roleFields } : { ...roleFields, ...value }
	}
	const remapRefs = (candidate: unknown): unknown =>
		Array.isArray(candidate)
			? candidate.map((reference) => (reference === "artifact_1" && evidenceIds[0] ? evidenceIds[0] : reference))
			: candidate
	const findings = Array.isArray(value.findings)
		? value.findings.map((finding) =>
				finding && typeof finding === "object" && !Array.isArray(finding)
					? { ...finding, evidence_refs: remapRefs((finding as { evidence_refs?: unknown }).evidence_refs) }
					: finding,
			)
		: value.findings
	return { schema_version: 1, ...value, findings, role, ...roleFields }
}

function reviewRequirementIds(payload: Record<string, unknown> | undefined): string[] {
	if (Array.isArray(payload?.allowed_requirement_ids)) {
		return payload.allowed_requirement_ids.filter((value): value is string => typeof value === "string")
	}
	if (!Array.isArray(payload?.requirements)) return []
	return payload.requirements
		.map((requirement) =>
			requirement && typeof requirement === "object" && !Array.isArray(requirement)
				? (requirement as { id?: unknown }).id
				: undefined,
		)
		.filter((value): value is string => typeof value === "string")
}

function reviewEvidenceIds(payload: Record<string, unknown> | undefined): string[] {
	if (Array.isArray(payload?.allowed_evidence_refs)) {
		return payload.allowed_evidence_refs.filter((value): value is string => typeof value === "string")
	}
	if (!Array.isArray(payload?.evidence)) return []
	const evidenceIds = payload.evidence
		.map((artifact) =>
			artifact && typeof artifact === "object" && !Array.isArray(artifact)
				? (artifact as { artifact_id?: unknown }).artifact_id
				: undefined,
		)
		.filter((value): value is string => typeof value === "string")
	const objective = payload.objective
	const objectiveId =
		objective && typeof objective === "object" && !Array.isArray(objective)
			? (objective as { artifact_id?: unknown }).artifact_id
			: undefined
	return typeof objectiveId === "string"
		? [objectiveId, ...evidenceIds.filter((artifactId) => artifactId !== objectiveId)]
		: evidenceIds
}

function judgeInputs(
	context: Context,
	payload: Record<string, unknown> | undefined,
): {
	findings: CouncilFinding[]
	evidenceIds: string[]
} {
	if (payload?.kind === "judge") {
		return {
			findings: Array.isArray(payload.allowed_findings) ? (payload.allowed_findings as CouncilFinding[]) : [],
			evidenceIds: Array.isArray(payload.allowed_evidence_refs)
				? payload.allowed_evidence_refs.filter((value): value is string => typeof value === "string")
				: [],
		}
	}
	const input = parseObject(userText(context))
	const reviews = Array.isArray(input?.reviews) ? input.reviews : []
	const findings = reviews.flatMap((review) => {
		if (!review || typeof review !== "object" || Array.isArray(review)) return []
		const candidate = (review as { findings?: unknown }).findings
		return Array.isArray(candidate) ? (candidate as CouncilFinding[]) : []
	})
	const task = input?.task
	const artifacts = Array.isArray(input?.evidence)
		? (input.evidence as Array<{ artifact_id?: unknown }>)
		: task &&
				typeof task === "object" &&
				!Array.isArray(task) &&
				Array.isArray((task as { artifacts?: unknown }).artifacts)
			? ((task as { artifacts: Array<{ artifact_id?: unknown }> }).artifacts ?? [])
			: []
	const constraints = Array.isArray(input?.constraints) ? (input.constraints as Array<{ artifact_id?: unknown }>) : []
	const objective =
		input?.objective && typeof input.objective === "object" && !Array.isArray(input.objective)
			? (input.objective as { artifact_id?: unknown })
			: undefined
	return {
		findings,
		evidenceIds: [objective, ...constraints, ...artifacts]
			.map((artifact) => artifact?.artifact_id)
			.filter((value): value is string => typeof value === "string"),
	}
}

function strictJudge(
	value: Record<string, unknown>,
	findings: CouncilFinding[],
	evidenceIds: string[],
): Record<string, unknown> {
	const strings = (candidate: unknown): string[] =>
		Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : []
	const analysis = {
		consensus: strings(value.consensus),
		contradictions: strings(value.contradictions),
		partial_coverage: strings(value.partial_coverage),
		unique_insights: strings(value.unique_insights),
		blind_spots: strings(value.blind_spots),
		unsupported_claims: strings(value.unsupported_claims),
		required_checks: strings(value.required_checks),
	}
	if (value.schema_version === 1 && Array.isArray(value.dispositions)) return { ...analysis, ...value }
	const disagreements = Array.isArray(value.disagreements) ? value.disagreements : []
	const critical = new Set(Array.isArray(value.critical_findings) ? value.critical_findings : [])
	const revisionInstructions = Array.isArray(value.revision_instructions)
		? value.revision_instructions.filter((item): item is string => typeof item === "string")
		: []
	const requiredChecks = Array.isArray(value.required_checks)
		? value.required_checks.filter((item): item is string => typeof item === "string")
		: []
	const fallbackEvidence = evidenceIds[0]
	const dispositions = findings.map((finding) => {
		const disagreement = disagreements.find(
			(item) =>
				item &&
				typeof item === "object" &&
				!Array.isArray(item) &&
				(item as { topic?: unknown }).topic === finding.statement,
		) as { resolved?: unknown; resolution?: unknown } | undefined
		const disagreementExtras = disagreement
			? Object.fromEntries(
					Object.entries(disagreement).filter(([key]) => !["topic", "impact", "resolved", "resolution"].includes(key)),
				)
			: {}
		const evidenceRefs =
			finding.evidence_refs.length > 0 ? finding.evidence_refs : fallbackEvidence ? [fallbackEvidence] : []
		if (disagreement?.resolved === true) {
			return {
				finding_id: finding.id,
				disposition: "resolved",
				rationale: typeof disagreement.resolution === "string" ? disagreement.resolution : "",
				evidence_refs: evidenceRefs,
				revision_instruction: null,
				required_check: null,
				...disagreementExtras,
			}
		}
		if (value.decision === "needs_evidence" || disagreement?.resolved === false) {
			return {
				finding_id: finding.id,
				disposition: "needs_evidence",
				rationale: "Fixture requires more evidence",
				evidence_refs: [],
				revision_instruction: null,
				required_check: requiredChecks[0] ?? finding.suggested_check ?? "Verify the finding",
			}
		}
		if (value.decision === "revise" || critical.has(finding.statement)) {
			return {
				finding_id: finding.id,
				disposition: "upheld",
				rationale: "Fixture upheld the finding",
				evidence_refs: evidenceRefs,
				revision_instruction: revisionInstructions[0] ?? `Resolve ${finding.id}`,
				required_check: null,
			}
		}
		return {
			finding_id: finding.id,
			disposition: "resolved",
			rationale: "Fixture resolved the finding from supplied evidence",
			evidence_refs: evidenceRefs,
			revision_instruction: null,
			required_check: null,
		}
	})
	const decision = dispositions.some(({ disposition }) => disposition === "needs_evidence")
		? "needs_evidence"
		: dispositions.some(({ disposition }) => disposition === "upheld")
			? "revise"
			: "accept"
	const known = new Set([
		"decision",
		"consensus",
		"contradictions",
		"partial_coverage",
		"unique_insights",
		"blind_spots",
		"critical_findings",
		"disagreements",
		"unsupported_claims",
		"required_checks",
		"revision_instructions",
		"agreement",
	])
	const extras = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)))
	return {
		schema_version: 1,
		decision,
		dispositions,
		...analysis,
		revision_instructions: revisionInstructions,
		agreement: value.agreement ?? "high",
		...extras,
	}
}

function normalizeText(text: string, context: Context): string {
	const value = parseObject(text)
	if (!value) return text
	const payload = parseObject(userText(context))
	const role = reviewerRole(context, payload)
	if (role && Array.isArray(value.findings))
		return JSON.stringify(strictReview(value, role, reviewEvidenceIds(payload), reviewRequirementIds(payload)))
	if (context.systemPrompt?.includes("Council judge") || payload?.kind === "judge") {
		const { findings, evidenceIds } = judgeInputs(context, payload)
		return JSON.stringify(strictJudge(value, findings, evidenceIds))
	}
	return text
}

export function withStrictCouncilFixtures(completeModel: CompletePhysicalModel): CompletePhysicalModel {
	return async (model, context, options) => {
		const message = await completeModel(model, context, options)
		return {
			...message,
			content: message.content.map((block) =>
				block.type === "text" ? { ...block, text: normalizeText(block.text, context) } : block,
			),
		}
	}
}
