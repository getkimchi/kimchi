/**
 * Judge — surviving LLM-as-judge surface after the gate-registry migration.
 *
 * Grading is no longer an LLM concern in ferment. The agent produces structured
 * gate verdicts (see gate-registry.ts) at every completion tool, and those
 * verdicts feed deterministic accept/refuse logic. The only judge call left in
 * the system is:
 *
 *   - judgeStepVerification — interprets a non-zero verify exit as pass / retry
 *     / fail. Tactical, narrow, runs only when a step's verify command actually
 *     exited non-zero. NOT grading.
 *
 * Everything else this module used to do (free-form phase reviews, A–F grading,
 * plan sanity checks, the final arbiter) has been replaced by the gate registry
 * and removed.
 *
 * Shared shapes (JudgeFlag, ReviewOutcome) are kept because review-evidence.ts
 * persists them — phases.ts converts both gate-flag verdicts and project-check
 * failures into JudgeFlag for a uniform on-disk audit trail.
 */

import { complete } from "@earendil-works/pi-ai"
import type { Grade } from "../../ferment/types.js"
import { getModelRoles, splitModelRef } from "../orchestration/model-roles.js"
import { getJudgeModel, getJudgeModelRegistry } from "./state.js"

const GRADES: Grade[] = ["A", "B", "C", "D", "F"]
const JOURNEY_GRADE_MAX_ATTEMPTS = 3

export function isGrade(value: unknown): value is Grade {
	return typeof value === "string" && (GRADES as string[]).includes(value)
}

// ─── Low-level API call ───────────────────────────────────────────────────────
//
// Typed result so callers can distinguish "no registry / no model / no key"
// from "model call errored" from "model returned no text."

export type JudgeUnavailableReason = "no_registry" | "no_model" | "no_auth" | "api_error" | "empty_response"

export type JudgeApiResult = { ok: true; text: string } | { ok: false; reason: JudgeUnavailableReason; detail?: string }

export async function judgeApiCall(systemPrompt: string, userMsg: string, maxTokens?: number): Promise<JudgeApiResult> {
	const registry = getJudgeModelRegistry()
	if (!registry) return { ok: false, reason: "no_registry" }

	const judgeAssignment = getModelRoles().judge
	const judgeModelStr = Array.isArray(judgeAssignment) ? judgeAssignment[0] : judgeAssignment
	const judgeRef = judgeModelStr ? splitModelRef(judgeModelStr) : undefined
	const model = (judgeRef ? registry.find(judgeRef.provider, judgeRef.modelId) : undefined) ?? getJudgeModel()
	if (!model) return { ok: false, reason: "no_model" }

	const auth = await registry.getApiKeyAndHeaders(model)
	if (!auth.ok || !auth.apiKey) return { ok: false, reason: "no_auth" }

	try {
		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userMsg }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: AbortSignal.timeout(45_000),
				...(maxTokens === undefined ? {} : { maxTokens }),
			},
		)

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
		if (!text) return { ok: false, reason: "empty_response" }
		return { ok: true, text }
	} catch (err) {
		return { ok: false, reason: "api_error", detail: err instanceof Error ? err.message : String(err) }
	}
}

// ─── Shared types ─────────────────────────────────────────────────────────────
//
// Kept for review-evidence.ts: phases.ts converts both agent-emitted gate
// flags and deterministic project-check failures into JudgeFlag, then persists
// them via writeReviewEvidence for the on-disk audit trail. No code path
// downstream of these types calls an LLM.

export type FlagSeverity = "warn" | "block"

export interface JudgeFlag {
	/** One sentence specific claim about what's wrong. */
	problem: string
	/** A quote, file:line, or diff line that supports the claim. */
	evidence: string
	/** "warn" = advisory, "block" = refuses advancement. */
	severity: FlagSeverity
	/** Imperative one-line instruction to the agent. */
	redirect: string
}

export interface ReviewOutcome {
	flags: JudgeFlag[]
	/** Pessimistic letter grade derived from flags. A only if all clear. */
	grade: Grade
	/** One-sentence summary. */
	rationale: string
	/** True when the judge was unreachable or returned unparseable output. */
	unavailable?: boolean
}

// ─── Output parsing (robust to common LLM JSON tics) ──────────────────────────

function tryParseJson<T>(raw: string): T | undefined {
	let s = raw.trim()
	if (s.startsWith("```")) {
		s = s
			.replace(/^```[a-z]*\n?/i, "")
			.replace(/```$/, "")
			.trim()
	}
	try {
		return JSON.parse(s) as T
	} catch {
		const m = s.match(/[{[][\s\S]*[}\]]/)
		if (!m) return undefined
		try {
			return JSON.parse(m[0]) as T
		} catch {
			return undefined
		}
	}
}

type JudgeCallResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: JudgeUnavailableReason | "unparseable"; detail?: string }

/** Coerce the model's `recommendations` field into a clean string[]. Accepts
 *  string[], a single string, or missing/garbage — always returns string[].
 *  Truncates to 20 entries and 600 chars each to bound persisted payload. */
function normalizeRecommendations(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw
			.map((item) => (typeof item === "string" ? item : ""))
			.filter((s) => s.trim().length > 0)
			.map((s) => s.slice(0, 600))
			.slice(0, 20)
	}
	if (typeof raw === "string" && raw.trim().length > 0) {
		return [raw.slice(0, 600)]
	}
	return []
}

async function judgeCall<T>(systemPrompt: string, userMsg: string, maxTokens: number): Promise<JudgeCallResult<T>> {
	const api = await judgeApiCall(systemPrompt, userMsg, maxTokens)
	if (!api.ok) return { ok: false, reason: api.reason, detail: api.detail }
	const parsed = tryParseJson<T>(api.text)
	if (parsed === undefined) return { ok: false, reason: "unparseable", detail: api.text.slice(0, 200) }
	return { ok: true, value: parsed }
}

// ─── Public API: step verification (interpret non-zero verify exit) ───────────

export interface JudgeVerdict {
	verdict: "pass" | "retry" | "fail"
	reason: string
}

const STEP_VERIFICATION_SYSTEM = `You are a strict verification triage judge. A step's verification command exited non-zero. You will decide:
- "pass":  the non-zero exit is benign (grep matched nothing as expected, linter warnings only, etc.). The work is acceptable.
- "retry": the failure looks transient (network blip, race, missing setup file that should exist next try).
- "fail":  the failure is a real implementation defect that must be fixed.

Be skeptical. When in doubt between pass/retry/fail, prefer "fail" — false-pass is the worst outcome.

Respond with EXACTLY one JSON object, no markdown, no prose:
{"verdict":"pass"|"retry"|"fail","reason":"<one sentence>"}`

export async function judgeStepVerification(
	stepDescription: string,
	verificationCommand: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): Promise<JudgeVerdict> {
	const user = `Step: "${stepDescription}"
Verification: \`${verificationCommand}\`
Exit: ${exitCode}
stdout:
${stdout.slice(0, 1200)}
stderr:
${stderr.slice(0, 1200)}`

	const result = await judgeCall<{ verdict?: string; reason?: string }>(STEP_VERIFICATION_SYSTEM, user, 150)
	// Fail-safe default: anything other than a clearly parsed pass/retry is a
	// fail. False-pass is the worst outcome at this stage.
	if (!result.ok) {
		const detail = result.reason === "unparseable" ? (result.detail ?? "unparseable response") : "Judge unavailable"
		return { verdict: "fail", reason: `${detail} — treating as failure.` }
	}
	const parsed = result.value
	const verdict = parsed.verdict === "pass" || parsed.verdict === "retry" ? parsed.verdict : "fail"
	return { verdict, reason: parsed.reason ?? "(no rationale provided)" }
}

// ─── Public API: journey grade (final ferment grade) ──────────────────────────
//
// At complete_ferment, after C-gates pass and the ferment transitions to
// "complete", this judge call assigns the final letter grade A–F. It reads
// the whole journey — per-phase F-gate verdicts, the final C-gates, the
// scope (goal + success criteria), and the total diff — and produces a
// pessimistic grade with a 2-3 sentence rationale citing specific evidence.
//
// The judge does NOT decide whether to ship. C-gates already did that. The
// judge measures HOW WELL the work was done.

export interface JourneyPhaseInput {
	name: string
	goal: string
	status: string
	/** Per-phase gate verdicts from the successful complete_ferment_phase attempt
	 *  (read from the on-disk review-evidence sidecar). Optional because
	 *  legacy ferments may lack the sidecar — judge sees "(no verdicts on
	 *  file)" in that case. */
	gateVerdicts?: Array<{ id: string; verdict: string; rationale: string }>
}

export interface JourneyGateVerdict {
	id: string
	verdict: string
	rationale: string
}

export interface JourneyDiff {
	available: boolean
	filesChanged?: string
	diffSnippet?: string
}

export interface JudgeJourneyGradeInput {
	fermentName: string
	goal: string
	successCriteria: string
	finalSummary: string
	phases: ReadonlyArray<JourneyPhaseInput>
	fermentGates: ReadonlyArray<JourneyGateVerdict>
	totalDiff?: JourneyDiff
	/** Agent-pasted execution evidence (command outputs, verification results,
	 *  file contents). Primary proof source when no git diff is available. */
	evidence?: string
}

export interface JudgeJourneyGradeOk {
	ok: true
	grade: Grade
	rationale: string
	/** Concrete fix bullets the grader recommends to reach A. Empty for A grades. */
	recommendations: string[]
}

export interface JudgeJourneyGradeFailure {
	ok: false
	reason: JudgeUnavailableReason | "unparseable" | "invalid_grade"
	detail?: string
}

export type JudgeJourneyGradeResult = JudgeJourneyGradeOk | JudgeJourneyGradeFailure

function withJourneyGradeAttemptDetail(failure: JudgeJourneyGradeFailure, attempts: number): JudgeJourneyGradeFailure {
	if (attempts <= 1) return failure
	const attemptDetail = `after ${attempts} attempts`
	return {
		...failure,
		detail: failure.detail ? `${attemptDetail}; ${failure.detail}` : attemptDetail,
	}
}

const JOURNEY_GRADE_SYSTEM = `You are a strict production-readiness review council compressed into one reviewer, acting as the final reviewer for an autonomous coding ferment. The agent has completed all phases and the ferment-scope gates (C1/C2/C3) all passed — so shipping is allowed. Your job is NOT to decide whether to ship. Your job is to evaluate the completed result against the stated goal, implementation, tests, and evidence, and assign a letter grade A–F that describes HOW WELL the work was done.

Your bias is PESSIMISTIC. Most work is B or C, not A. A is reserved for ferments that delivered cleanly without retries, with concrete real-execution verification at every phase, and where every gate verdict was substantiated with specific evidence.

## Hard constraints

- Do not treat claims as proof. Missing proof lowers the grade.
- Passing compile/build alone is not proof of runtime behavior.
- Skipped required tests are not pass evidence.
- Documentation of a problem is not remediation.
- Prefer concrete findings over vague concerns.
- Grade harshly when correctness, security, evidence, or production wiring is unclear.

## Internal review council

Run these reviews silently before assigning the grade.

### 1. Security attacker
Authentication/authorization, tenant isolation, privilege escalation, input validation, injection, XSS, SSRF, path traversal, command execution, secrets exposure, unsafe logging, weak crypto, unsafe config, unsafe external API/webhook/MCP/CI behavior, data leakage, privacy violations, audit gaps, missing abuse-case tests for security-sensitive code. Any critical/high security issue → F. Any medium security issue caps the grade at D.

### 2. Architecture / principal review
Correct boundary placement and abstraction level, simpler viable alternative ignored, excessive coupling or hidden dependency, production code not wired into a production path, domain invariant violations, backward-compat scaffolding added without explicit approval, durability/replay/audit/privacy/consistency assumptions violated, SQL/index/partition changes without query or write-path justification. Unwired production code, invalid boundaries, domain invariant violations, or unjustified durability weakening cap the grade at D or F depending on severity.

### 3. Operational pragmatist review
Missing observability for unattended paths, poor error handling, swallowed errors, vague diagnostics, missing cancellation/timeout/retry/lifecycle handling, unbounded goroutines/loops/memory growth/queues, deployment/runtime behavior not proven, config/env failure modes not clear, recovery/debuggability gaps. Operational gaps that would block diagnosis or safe runtime use cap the grade at D.

### 4. Code quality review
Dead code, unused exports, unreachable branches, abandoned files, TODO/FIXME stubs, placeholder behavior, debug artifacts, test-only artifacts imported by production code, hand-written mocks where generated mocks are required, unsafe casts, broad any, nil guards hiding required dependencies, speculative abstractions, performance footguns (N+1 queries, per-row durable commits, speculative indexes, unbounded work). Production/test leakage, placeholder implementation, hand-written mocks where forbidden, or dead code affecting production readiness cap the grade at D.

### 5. Test and verification review
Classify evidence for each requirement: proven / missing / stale / ambiguous / compile-only / skipped-expected / skipped-unexpected / failed. Check required behavior has current tests, error paths and edge cases are covered, integration/runtime evidence exists when required, UI/auth/live flows verified in a real runtime, test output is parseable and not hiding skips, performance claims have runtime/trace evidence, verification commands match the changed surface. Failed required verification → F. Missing required runtime evidence caps at D. Compile-only evidence for runtime behavior caps at D. Unexpected skipped required tests cap at D or F.

### 6. UX / UI review (if applicable)
For UI or user-facing behavior: design-system consistency, accessibility, navigation and information hierarchy, empty/loading/error states, mobile/responsive behavior, clear copy and obvious next actions, browser/runtime evidence for the actual rendered flow. Missing UI runtime validation for UI work caps at D.

## Moderator rules

After internal specialist review: cluster duplicate issues, separate proven findings from hypotheses, classify evidence strength, identify blockers, assign one final grade. If the grade is not A, recommend the concrete fixes needed to reach A.

## Grade rubric

- A: Excellent, production-ready. All required behavior is implemented, wired, tested, and verified with appropriate evidence. Architecture simple and aligned. Security, operations, UX, and maintainability have no meaningful concerns. Only trivial nits, if any.
- B: Good and shippable. Core behavior correct and verified. Minor low-risk issues exist, but no blocker, no missing critical evidence, no security concern, no production-wiring gap, and no maintainability risk likely to hurt near-term work.
- C: Acceptable but concerning. Probably works, but has moderate issues: incomplete edge coverage, some weak evidence, mild maintainability concerns, minor UX gaps, or non-blocking operational weaknesses. Should be improved, but not clearly unsafe or broken.
- D: Not production-ready. At least one must-fix issue: missing required verification, compile-only proof for runtime behavior, unexpected skipped required tests, unwired production code, significant architecture/quality/operational gap, medium security issue, missing UI runtime evidence, or maintainability risk that will likely cause defects.
- F: Fail. Core requirement not met, implementation broken, required tests fail, evidence absent or fabricated, critical/high security issue, data loss/privacy/audit risk, build/runtime broken, or change unsafe to ship.

## You will be given

- The ferment goal and success criteria.
- A per-phase trail: name, goal, status, and the F-gate verdicts the agent provided at complete_ferment_phase.
- The final C-gate verdicts the agent provided at complete_ferment.
- The total diff (files changed + snippet) from ferment start to now, when available.
- Execution evidence (agent-provided): real command outputs, verification results, or file contents that prove the work was done. This is the primary proof source when no diff is available.
- The agent's final summary.

## Final output

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<2-3 sentences citing specific phases, gates, or diff regions>","recommendations":["<bullet>",...]}

If grade is A, recommendations MUST be an empty array [].
If grade is B–F, each recommendation must include: what is wrong, why it matters, what must change, and what evidence would prove the fix. Do not include vague advice or "nice to have" items.`

function buildJourneyGradeUserMsg(input: JudgeJourneyGradeInput): string {
	const parts: string[] = []
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Goal: ${input.goal || "(none specified)"}`)
	parts.push(`Success criteria: ${input.successCriteria || "(none specified)"}`)
	parts.push(`Final summary: ${input.finalSummary || "(none)"}`)
	parts.push("")
	parts.push("Per-phase trail:")
	for (const p of input.phases) {
		parts.push(`  - Phase "${p.name}" [${p.status}] — ${p.goal}`)
		if (!p.gateVerdicts || p.gateVerdicts.length === 0) {
			parts.push("    (no verdicts on file)")
		} else {
			for (const v of p.gateVerdicts) {
				parts.push(`    ${v.id} (${v.verdict}): ${v.rationale}`)
			}
		}
	}
	parts.push("")
	parts.push("Ferment-scope gate verdicts:")
	for (const v of input.fermentGates) {
		parts.push(`  ${v.id} (${v.verdict}): ${v.rationale}`)
	}
	if (input.totalDiff?.available) {
		parts.push("")
		parts.push("--- TOTAL DIFF ---")
		parts.push(`Files changed:\n${input.totalDiff.filesChanged ?? "(none recorded)"}`)
		if (input.totalDiff.diffSnippet) {
			parts.push(`\nDiff snippet:\n\`\`\`diff\n${input.totalDiff.diffSnippet}\n\`\`\``)
		}
	} else {
		parts.push("")
		parts.push("(No diff available — judge on verdicts + summary only.)")
	}
	if (input.evidence && input.evidence.trim().length > 0) {
		parts.push("")
		parts.push("--- EXECUTION EVIDENCE (agent-provided) ---")
		parts.push(input.evidence.slice(0, 4000))
	}
	return parts.join("\n")
}

export async function judgeJourneyGrade(
	input: JudgeJourneyGradeInput,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<JudgeJourneyGradeResult> {
	const userMsg = buildJourneyGradeUserMsg(input)
	for (let attempt = 1; attempt <= JOURNEY_GRADE_MAX_ATTEMPTS; attempt++) {
		const api = await apiCall(JOURNEY_GRADE_SYSTEM, userMsg)
		if (!api.ok) {
			const failure: JudgeJourneyGradeFailure = { ok: false, reason: api.reason, detail: api.detail }
			if (api.reason === "empty_response" && attempt < JOURNEY_GRADE_MAX_ATTEMPTS) continue
			return withJourneyGradeAttemptDetail(failure, attempt)
		}

		const parsed = tryParseJson<{ grade?: string; rationale?: string; recommendations?: unknown }>(api.text)
		if (parsed === undefined) {
			return { ok: false, reason: "unparseable", detail: api.text.slice(0, 200) }
		}
		if (!isGrade(parsed.grade)) {
			return { ok: false, reason: "invalid_grade", detail: `Judge returned: ${parsed.grade}` }
		}
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 800) : "(no rationale provided)"
		const recommendations = normalizeRecommendations(parsed.recommendations)
		return { ok: true, grade: parsed.grade, rationale, recommendations }
	}

	throw new Error("unreachable: journey grade retry loop exited without a result")
}

// ─── Public API: phase grade (per-phase LLM review) ───────────────────────────
//
// At complete_ferment_phase, after the F-gates and project checks pass, this
// judge assigns a per-phase letter grade A–F. It reads the phase goal, the
// F-gate verdicts the agent provided, the project-check summary, the phase
// diff, and the phase summary, and produces a pessimistic grade with a
// rationale and concrete recommendations when the grade is not A.
//
// Unlike the journey grade, this is a SIMPLIFIED council: it drops the
// UX/UI review and the full-project architecture review (a single phase
// rarely warrants them) and keeps the security, code-quality, test/
// verification, and operational-pragmatist reviews plus the moderator and
// rubric. The grade drives advancement: A/B advance, C/D/F refuse and route
// through the existing MAX_BLOCK_RETRIES / escalation loop.

export interface JudgePhaseInput {
	fermentName: string
	phaseName: string
	phaseGoal: string
	/** The agent's complete_ferment_phase summary. */
	phaseSummary: string
	/** Step summaries rendered as a single text block (one bullet per step). */
	stepSummaries?: string
	/** F-gate verdicts the agent provided at complete_ferment_phase. */
	gateVerdicts: ReadonlyArray<{ id: string; verdict: string; rationale: string }>
	/** Project-check summary text, if project checks ran. */
	projectChecksSummary?: string
	/** Phase diff (files changed + snippet) from the phase's evidence. */
	phaseDiff?: JourneyDiff
	/** Agent-pasted execution evidence (command outputs, verification results,
	 *  file contents). Primary proof source when no git diff is available. */
	evidence?: string
}

export interface JudgePhaseGradeOk {
	ok: true
	grade: Grade
	rationale: string
	/** Concrete fix bullets the grader recommends to reach A. Empty for A grades. */
	recommendations: string[]
}

export interface JudgePhaseGradeFailure {
	ok: false
	reason: JudgeUnavailableReason | "unparseable" | "invalid_grade"
	detail?: string
}

export type JudgePhaseGradeResult = JudgePhaseGradeOk | JudgePhaseGradeFailure

const PHASE_GRADE_SYSTEM = `You are a strict production-readiness review council compressed into one reviewer, acting as the per-phase reviewer for an autonomous coding ferment. The agent has completed a single phase and the phase-scope gates (F1/F2/F3) all passed — so phase advancement is allowed by the gates. Your job is NOT to decide whether the phase advances. Your job is to evaluate the phase result against its stated goal, implementation, tests, and evidence, and assign a letter grade A–F that describes HOW WELL the phase was done.

Your bias is PESSIMISTIC. Most phase work is B or C, not A. A is reserved for phases that delivered cleanly without retries, with concrete real-execution verification, and where every gate verdict was substantiated with specific evidence.

## Hard constraints

- Do not treat claims as proof. Missing proof lowers the grade.
- Passing compile/build alone is not proof of runtime behavior.
- Skipped required tests are not pass evidence.
- Documentation of a problem is not remediation.
- Prefer concrete findings over vague concerns.
- Grade harshly when correctness, security, evidence, or production wiring is unclear.

## Internal review council

Run these reviews silently before assigning the grade.

### 1. Security attacker
Authentication/authorization, tenant isolation, privilege escalation, input validation, injection, XSS, SSRF, path traversal, command execution, secrets exposure, unsafe logging, weak crypto, unsafe config, unsafe external API/webhook/MCP/CI behavior, data leakage, privacy violations, audit gaps, missing abuse-case tests for security-sensitive code. Any critical/high security issue → F. Any medium security issue caps the grade at D.

### 2. Operational pragmatist review
Missing observability for unattended paths, poor error handling, swallowed errors, vague diagnostics, missing cancellation/timeout/retry/lifecycle handling, unbounded goroutines/loops/memory growth/queues, deployment/runtime behavior not proven, config/env failure modes not clear, recovery/debuggability gaps. Operational gaps that would block diagnosis or safe runtime use cap the grade at D.

### 3. Code quality review
Dead code, unused exports, unreachable branches, abandoned files, TODO/FIXME stubs, placeholder behavior, debug artifacts, test-only artifacts imported by production code, hand-written mocks where generated mocks are required, unsafe casts, broad any, nil guards hiding required dependencies, speculative abstractions, performance footguns (N+1 queries, per-row durable commits, speculative indexes, unbounded work). Production/test leakage, placeholder implementation, hand-written mocks where forbidden, or dead code affecting production readiness cap the grade at D.

### 4. Test and verification review
Classify evidence for each requirement: proven / missing / stale / ambiguous / compile-only / skipped-expected / skipped-unexpected / failed. Check required behavior has current tests, error paths and edge cases are covered, integration/runtime evidence exists when required, test output is parseable and not hiding skips, performance claims have runtime/trace evidence, verification commands match the changed surface. Failed required verification → F. Missing required runtime evidence caps at D. Compile-only evidence for runtime behavior caps at D. Unexpected skipped required tests cap at D or F.

## Moderator rules

After internal specialist review: cluster duplicate issues, separate proven findings from hypotheses, classify evidence strength, identify blockers, assign one final grade. If the grade is not A, recommend the concrete fixes needed to reach A.

## Grade rubric

- A: Excellent, production-ready phase. All required behavior is implemented, wired, tested, and verified with appropriate evidence. No meaningful concerns. Only trivial nits, if any.
- B: Good and shippable phase. Core behavior correct and verified. Minor low-risk issues exist, but no blocker, no missing critical evidence, no security concern, and no maintainability risk likely to hurt near-term work.
- C: Acceptable but concerning. Probably works, but has moderate issues: incomplete edge coverage, some weak evidence, mild maintainability concerns, or non-blocking operational weaknesses. Should be improved, but not clearly unsafe or broken.
- D: Not production-ready. At least one must-fix issue: missing required verification, compile-only proof for runtime behavior, unexpected skipped required tests, significant quality/operational gap, medium security issue, or maintainability risk that will likely cause defects.
- F: Fail. Core phase requirement not met, implementation broken, required tests fail, evidence absent or fabricated, critical/high security issue, or the change is unsafe to ship.

## You will be given

- The ferment name and the phase name + goal.
- The agent's phase summary and per-step summaries.
- The F-gate verdicts the agent provided at complete_ferment_phase.
- The project-check summary (if any).
- The phase diff (files changed + snippet) when available.
- Execution evidence (agent-provided): real command outputs, verification results, or file contents that prove the work was done. This is the primary proof source when no diff is available.

## Final output

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<2-3 sentences citing specific gates, steps, or diff regions>","recommendations":["<bullet>",...]}

If grade is A, recommendations MUST be an empty array [].
If grade is B–F, each recommendation must include: what is wrong, why it matters, what must change, and what evidence would prove the fix. Do not include vague advice or "nice to have" items.`

function buildPhaseGradeUserMsg(input: JudgePhaseInput): string {
	const parts: string[] = []
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Phase: "${input.phaseName}"`)
	parts.push(`Phase goal: ${input.phaseGoal || "(none specified)"}`)
	parts.push(`Phase summary: ${input.phaseSummary || "(none)"}`)
	if (input.stepSummaries && input.stepSummaries.trim().length > 0) {
		parts.push("")
		parts.push("Step summaries:")
		parts.push(input.stepSummaries)
	}
	parts.push("")
	parts.push("Phase-scope gate verdicts:")
	for (const v of input.gateVerdicts) {
		parts.push(`  ${v.id} (${v.verdict}): ${v.rationale}`)
	}
	if (input.projectChecksSummary && input.projectChecksSummary.trim().length > 0) {
		parts.push("")
		parts.push("Project checks:")
		parts.push(input.projectChecksSummary)
	}
	if (input.phaseDiff?.available) {
		parts.push("")
		parts.push("--- PHASE DIFF ---")
		parts.push(`Files changed:\n${input.phaseDiff.filesChanged ?? "(none recorded)"}`)
		if (input.phaseDiff.diffSnippet) {
			parts.push(`\nDiff snippet:\n\`\`\`diff\n${input.phaseDiff.diffSnippet}\n\`\`\``)
		}
	} else {
		parts.push("")
		parts.push("(No diff available — judge on verdicts + summary only.)")
	}
	if (input.evidence && input.evidence.trim().length > 0) {
		parts.push("")
		parts.push("--- EXECUTION EVIDENCE (agent-provided) ---")
		parts.push(input.evidence.slice(0, 4000))
	}
	return parts.join("\n")
}

export async function judgePhaseGrade(
	input: JudgePhaseInput,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<JudgePhaseGradeResult> {
	const userMsg = buildPhaseGradeUserMsg(input)
	for (let attempt = 1; attempt <= JOURNEY_GRADE_MAX_ATTEMPTS; attempt++) {
		const api = await apiCall(PHASE_GRADE_SYSTEM, userMsg)
		if (!api.ok) {
			const failure: JudgePhaseGradeFailure = { ok: false, reason: api.reason, detail: api.detail }
			if (api.reason === "empty_response" && attempt < JOURNEY_GRADE_MAX_ATTEMPTS) continue
			return withJourneyGradeAttemptDetail(failure, attempt)
		}

		const parsed = tryParseJson<{ grade?: string; rationale?: string; recommendations?: unknown }>(api.text)
		if (parsed === undefined) {
			return { ok: false, reason: "unparseable", detail: api.text.slice(0, 200) }
		}
		if (!isGrade(parsed.grade)) {
			return { ok: false, reason: "invalid_grade", detail: `Judge returned: ${parsed.grade}` }
		}
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 800) : "(no rationale provided)"
		const recommendations = normalizeRecommendations(parsed.recommendations)
		return { ok: true, grade: parsed.grade, rationale, recommendations }
	}

	throw new Error("unreachable: phase grade retry loop exited without a result")
}
