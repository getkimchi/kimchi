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

import type { Api, Model } from "@earendil-works/pi-ai"
import { complete } from "@earendil-works/pi-ai/compat"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { CharterClauseVerdict, FermentCharter, Grade } from "../../ferment/types.js"
import { omitKimchiMaxTokensFromPayload } from "../omit-kimchi-max-tokens.js"
import { getModelRoles, splitModelRef } from "../orchestration/model-roles.js"
import { renderCharterFull } from "./charter.js"
import { getJudgeModel, getJudgeModelRegistry, isJudgeMultiModelEnabled } from "./state.js"

const GRADES: Grade[] = ["A", "B", "C", "D", "F"]
const JOURNEY_GRADE_MAX_ATTEMPTS = 3

/** Recommendation contract shared by every grader prompt (council system
 *  prompts and subagent user prompts). Graders run in a headless session —
 *  asks for evidence the environment cannot produce (screenshots, recordings,
 *  live demos) turn remediation loops into superstition. Keep demands
 *  producible, few, and severity-ordered. */
const RECOMMENDATION_CONTRACT = `Recommendation contract (applies whenever the grade is not A):
- At most 3 recommendations, ordered by severity (highest impact first).
- Each must include: what is wrong, why it matters, what must change, and what evidence would prove the fix.
- Each recommendation MUST end with a fix-check the executing agent can run in this environment to evaluate its own fix before re-calling: a command, a file inspection, or a grep that unambiguously passes only once the defect is gone. Template: "Check: <command or inspection> must now show <expected result>".
- The fix-check must be sound in a headless test environment: do NOT demand browser-rendered properties (computed CSS from stylesheets, focus halos, z-order paint, real timers) that jsdom/happy-dom cannot evaluate; instead name a check on the source itself (e.g. token defined in index.css, no inline style overriding the CSS rule, dependency array contains X) plus the existing test suite still passing.
- Request ONLY evidence this headless environment can produce: command output (builds, tests, linters), file contents, and diffs. NEVER request screenshots, screen recordings, GIFs, live demos, or manual UI walkthroughs — they cannot be satisfied here.
- If a concern genuinely needs human eyes (visual polish, UX feel), mark it "manual review needed". Manual-review items are advisory only and MUST NOT be the reason for a downgrade or refusal.
- No vague advice or "nice to have" items.`

export function isGrade(value: unknown): value is Grade {
	return typeof value === "string" && (GRADES as string[]).includes(value)
}

// ─── Low-level API call ───────────────────────────────────────────────────────
//
// Typed result so callers can distinguish "no registry / no model / no key"
// from "model call errored" from "model returned no text."

export type JudgeUnavailableReason = "no_registry" | "no_model" | "no_auth" | "api_error" | "empty_response"

export type JudgeApiResult = { ok: true; text: string } | { ok: false; reason: JudgeUnavailableReason; detail?: string }

/** Resolve the model the judge grades with: in multi-model mode the configured
 *  `modelRoles.judge` assignment (falling back to the captured session model
 *  when it doesn't resolve); in single-model mode the captured session model —
 *  roles never apply there. */
function resolveJudgeModel(registry: ModelRegistry | undefined): Model<Api> | undefined {
	if (!isJudgeMultiModelEnabled()) return getJudgeModel()
	const judgeAssignment = getModelRoles().judge
	const judgeModelStr = Array.isArray(judgeAssignment) ? judgeAssignment[0] : judgeAssignment
	const judgeRef = judgeModelStr ? splitModelRef(judgeModelStr) : undefined
	return (judgeRef && registry ? registry.find(judgeRef.provider, judgeRef.modelId) : undefined) ?? getJudgeModel()
}

/**
 * Resolve the judge model's display ref for observability (mirrors
 * judgeApiCall's resolution — both go through resolveJudgeModel). Returns
 * `provider/id`, or undefined when neither side is known (unit tests that
 * inject apiCall hit this).
 */
export function describeJudgeModel(): string | undefined {
	const model = resolveJudgeModel(getJudgeModelRegistry())
	if (!model) return undefined
	return `${model.provider}/${model.id}`
}

export async function judgeApiCall(systemPrompt: string, userMsg: string, maxTokens?: number): Promise<JudgeApiResult> {
	const registry = getJudgeModelRegistry()
	if (!registry) return { ok: false, reason: "no_registry" }

	const model = resolveJudgeModel(registry)
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
				...(maxTokens === undefined
					? { onPayload: (payload: unknown) => omitKimchiMaxTokensFromPayload(payload, model.provider) }
					: { maxTokens }),
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
	/** Certified phase grade (letter + refusal recommendations) from the phase
	 *  grader — passed through so the journey grader can delta-scope its audit:
	 *  verify integration + charter, don't re-audit each phase line-by-line. */
	grade?: { grade: string; recommendations?: string[] }
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
	/** Intent charter rendered into the grading prompt when present — the
	 *  original, un-narrowed user intent the grade answers to. */
	charter?: FermentCharter
	successCriteria: string
	finalSummary: string
	phases: ReadonlyArray<JourneyPhaseInput>
	fermentGates: ReadonlyArray<JourneyGateVerdict>
	totalDiff?: JourneyDiff
	/** Agent-pasted execution evidence (command outputs, verification results,
	 *  file contents). Primary proof source when no git diff is available. */
	evidence?: string
	/** The previous journey refusal (grade + recommendations + timestamp) on a
	 *  retry after an LLM refusal — or the most recent phase refusal ahead of
	 *  the first journey attempt (quality momentum: verify those items stayed
	 *  fixed). Absent on a first-ever attempt with no prior refusals. */
	priorRefusal?: { grade: string; recommendations: string[]; at: string }
	/** Harness-verbatim summary of deterministic step verification executions
	 *  across all phases (commands, exit codes, trimmed outputs), gathered by
	 *  gatherStepVerifyEvidence. Attached when present so the journey grader
	 *  does not have to re-run the verification matrix blind. */
	stepVerificationRuns?: string
}

export interface JudgeJourneyGradeOk {
	ok: true
	grade: Grade
	rationale: string
	/** Concrete fix bullets the grader recommends to reach A. Empty for A grades. */
	recommendations: string[]
	/** Ship-level charter audit: per-clause met/waived/unmet verdicts, present
	 *  only when the ferment has an intent charter and the grader returned them. */
	charterVerdicts?: CharterClauseVerdict[]
	/** Provenance — set by the ViaSubagent wrappers. Undefined when the
	 *  single-shot path was called directly (e.g. no agent system active). */
	graderSource?: GraderSource
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

When an intent charter is provided below, grade how well the result fulfills the user's ORIGINAL INTENT recorded there — the plan and criteria only refine it. A result faithful to narrowed criteria but missing the intent is at best C.

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
If grade is B–F, follow the recommendation contract below.

${RECOMMENDATION_CONTRACT}

If an intent charter was provided above, also return per-clause verdicts — one entry per charter clause (the intent itself, wow factor, confirmed scope, acceptance demo when present):
{"grade":"A","rationale":"...","recommendations":[],"charter_verdicts":[{"clause":"<clause text, shortened>","status":"met"|"waived"|"unmet","evidence":"<what demonstrates it>"}]}
Use "unmet" when the finished artifact does not deliver what that clause asks, and "waived" only when the deviation was explicitly accepted (e.g. recorded in constraints with a named cost). Unmet clauses are strong downgrade signals under the rubric but do not gate ship by themselves.
charter_verdicts is REQUIRED when an intent charter was provided; omit it ONLY when no charter was provided.`

function buildJourneyGradeUserMsg(input: JudgeJourneyGradeInput): string {
	const parts: string[] = []
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Goal: ${input.goal || "(none specified)"}`)
	if (input.charter) {
		parts.push("")
		parts.push(renderCharterFull(input.charter))
	}
	parts.push(`Success criteria: ${input.successCriteria || "(none specified)"}`)
	parts.push(`Final summary: ${input.finalSummary || "(none)"}`)
	parts.push("")
	parts.push("Per-phase trail:")
	for (const p of input.phases) {
		parts.push(
			`  - Phase "${p.name}" [${p.status}] — ${p.goal}${p.grade ? ` — graded ${p.grade.grade} by phase grader` : ""}`,
		)
		if (!p.gateVerdicts || p.gateVerdicts.length === 0) {
			parts.push("    (no verdicts on file)")
		} else {
			for (const v of p.gateVerdicts) {
				parts.push(`    ${v.id} (${v.verdict}): ${v.rationale}`)
			}
		}
	}
	parts.push("")
	if (input.phases.some((p) => p.grade)) {
		parts.push(
			"Phases marked 'graded X by phase grader' carry certified phase-level verdicts; do not re-litigate them.",
		)
		parts.push("")
	}
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
	if (input.stepVerificationRuns) {
		parts.push("")
		parts.push("--- HARNESS-EXECUTED VERIFICATION (deterministic re-run) ---")
		parts.push(
			"Each declared step verification was executed by the harness with its exit code and trimmed output. ✓ = exit 0. Attached verbatim; missing entries are marked (no verify command declared / declared, never executed).",
		)
		parts.push(input.stepVerificationRuns)
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
	const baseMsg = buildJourneyGradeUserMsg(input)
	let missingVerdicts = false
	for (let attempt = 1; attempt <= JOURNEY_GRADE_MAX_ATTEMPTS; attempt++) {
		// After a charter-verdict miss the retry barely differs from the prompt
		// that already produced one miss. Name exactly what was omitted so the
		// judge knows what to fix rather than re-rolling the same failure mode.
		const userMsg = missingVerdicts
			? `${baseMsg}\n\nREMINDER: your previous response omitted \`charter_verdicts\`. Include it as required by the contract above — one entry per charter clause, each with status met/waived/unmet and the evidence behind the verdict.`
			: baseMsg
		const api = await apiCall(JOURNEY_GRADE_SYSTEM, userMsg)
		if (!api.ok) {
			const failure: JudgeJourneyGradeFailure = { ok: false, reason: api.reason, detail: api.detail }
			if (api.reason === "empty_response" && attempt < JOURNEY_GRADE_MAX_ATTEMPTS) continue
			return withJourneyGradeAttemptDetail(failure, attempt)
		}

		const parsed = tryParseJson<{
			grade?: string
			rationale?: string
			recommendations?: unknown
			charter_verdicts?: unknown
		}>(api.text)
		if (parsed === undefined) {
			return { ok: false, reason: "unparseable", detail: api.text.slice(0, 200) }
		}
		if (!isGrade(parsed.grade)) {
			return { ok: false, reason: "invalid_grade", detail: `Judge returned: ${parsed.grade}` }
		}
		const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 800) : "(no rationale provided)"
		const recommendations = normalizeRecommendations(parsed.recommendations)
		const charterVerdicts = normalizeCharterVerdicts(parsed.charter_verdicts)
		if (input.charter && !charterVerdicts && attempt < JOURNEY_GRADE_MAX_ATTEMPTS) {
			// Charter audit is required when a charter exists: retry (soft — the
			// final attempt may proceed without verdicts; complete_ferment renders
			// an honest omission breadcrumb in that case).
			missingVerdicts = true
			continue
		}
		return {
			ok: true,
			grade: parsed.grade,
			rationale,
			recommendations,
			...(charterVerdicts ? { charterVerdicts } : {}),
		}
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
	/** Intent charter rendered into the grading prompt when present — the
	 *  original, un-narrowed user intent this phase should serve. */
	charter?: FermentCharter
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
	/** Harness-executed step verify runs (command, exit code, output tails).
	 *  Deterministic — not agent-written, so the grader gets "what actually
	 *  ran" for free instead of having to demand pasted terminal output. */
	stepVerificationRuns?: string
	/** The latest grader refusal of this phase (present on retry attempts).
	 *  Lets the re-grader delta-grade: verify the refused items are now fixed
	 *  and scan for new breakage, instead of a whole-phase re-sweep. */
	priorRefusal?: { grade: string; recommendations: string[]; at: string }
}

/** Render the delta-grading section when a phase or journey was previously
 *  refused. Shared by the phase and journey prompt builders. `subject` reads
 *  as "this phase" or "the ferment" in the emitted sentences. */
function renderPriorRefusalSection(
	refusal: { grade: string; recommendations: string[]; at: string } | undefined,
	subject: "this phase" | "the ferment",
): string[] {
	if (!refusal) return []
	const lines = [
		"--- PRIOR REFUSAL — DELTA-GRADE INSTRUCTIONS ---",
		`A previous grader refused ${subject} at grade ${refusal.grade} (${refusal.at}) with these recommendations:`,
	]
	for (const [i, rec] of refusal.recommendations.entries()) {
		lines.push(`  ${i + 1}. ${rec}`)
	}
	lines.push(
		"First verify each item above is now addressed, citing the evidence per item. Then scan ONLY for new issues introduced by the fix wave — do not re-litigate previously accepted aspects unless the fix broke them. Still return a full fresh grade.",
	)
	return lines
}

/** When every attached step-verification execution is green, instruct the
 *  grader to spend its budget on code inspection + spot checks instead of
 *  re-running the verification matrix the harness already re-ran
 *  deterministically. Absent when evidence is missing or any run failed — a
 *  grader facing red or absent evidence must verify everything itself. */
function renderEvidenceTrustPolicy(stepVerificationRuns: string | undefined): string[] {
	if (!stepVerificationRuns) return []
	if (!stepVerificationRuns.includes("✓") || stepVerificationRuns.includes("✗")) return []
	return [
		"--- VERIFICATION EVIDENCE POLICY ---",
		"The attached step verification block below was produced by deterministic harness re-runs (not agent self-attestation) and every exit is green. Treat it as THE record of the verification matrix's most recent run.",
		"Graders have been observed rationalizing full re-runs ('to be sure', 'to catch anything not covered', 'it's part of the grade process'). Those excuses re-run everything and are explicitly invalid here:",
		"1. Do not re-run a suite the evidence covers. Full stop.",
		"2. You may run a command only if you can name the specific uncovered claim it proves (file:symbol:behavior) before running it — or the evidence is stale (executions older than ~10 minutes and code changed since).",
		"3. Spend your budget reading code and probing behavior the matrix does not cover — targeted regions (grep + focused reads), not whole files end-to-end.",
	]
}

/** Where a grade came from: the tool-equipped grader subagent, or the blind
 *  single-shot fallback engaged when the subagent was unusable (spawn failed /
 *  aborted / unparseable). Fallback grades are advisory-only — never refuse. */
export type GraderSource = "subagent" | "fallback_single_shot"

export interface JudgePhaseGradeOk {
	ok: true
	grade: Grade
	rationale: string
	/** Concrete fix bullets the grader recommends to reach A. Empty for A grades. */
	recommendations: string[]
	/** Provenance — set by the ViaSubagent wrappers. Undefined when the
	 *  single-shot path was called directly (e.g. no agent system active). */
	graderSource?: GraderSource
}

export interface JudgePhaseGradeFailure {
	ok: false
	reason: JudgeUnavailableReason | "unparseable" | "invalid_grade"
	detail?: string
}

export type JudgePhaseGradeResult = JudgePhaseGradeOk | JudgePhaseGradeFailure

const PHASE_GRADE_SYSTEM = `You are a strict production-readiness review council compressed into one reviewer, acting as the per-phase reviewer for an autonomous coding ferment. The agent has completed a single phase and the phase-scope gates (F1/F2/F3) all passed — so phase advancement is allowed by the gates. Your job is NOT to decide whether the phase advances. Your job is to evaluate the phase result against its stated goal, implementation, tests, and evidence, and assign a letter grade A–F that describes HOW WELL the phase was done.

Your bias is PESSIMISTIC. Most phase work is B or C, not A. A is reserved for phases that delivered cleanly without retries, with concrete real-execution verification, and where every gate verdict was substantiated with specific evidence.

When an intent charter is provided below, grade this phase's contribution toward the user's ORIGINAL INTENT recorded there, not only toward the enumerated step outputs.

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
If grade is B–F, follow the recommendation contract below.

${RECOMMENDATION_CONTRACT}`

function buildPhaseGradeUserMsg(input: JudgePhaseInput): string {
	const parts: string[] = []
	for (const line of renderPriorRefusalSection(input.priorRefusal, "this phase")) parts.push(line)
	if (input.priorRefusal) parts.push("")
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Phase: "${input.phaseName}"`)
	parts.push(`Phase goal: ${input.phaseGoal || "(none specified)"}`)
	if (input.charter) {
		parts.push("")
		parts.push(renderCharterFull(input.charter))
	}
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
	if (input.stepVerificationRuns && input.stepVerificationRuns.trim().length > 0) {
		parts.push("")
		parts.push("--- STEP VERIFICATION RUNS (executed by the harness) ---")
		parts.push(input.stepVerificationRuns)
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

// ─── Subagent-based grading ───────────────────────────────────────────────────
//
// The subagent grader spawns a bounded agent with read-only + bash tools so it
// can independently verify the agent's claims (run tests, read source files,
// check output files). Falls back to the single-shot judgeApiCall() when the
// subagent is unavailable, crashes, or produces unparseable output.

/** Result from a grader subagent invocation. */
export interface GraderSubagentResult {
	/** The full text output from the subagent (may contain multiple assistant turns). */
	text: string
	/** "completed" = finished normally; "steered" = hit the soft turn cap but
	 *  wrapped up in time (a success — see agent-manager classifyAgentOutcome);
	 *  anything else = aborted/errored and unusable. */
	status: string
}

/** Spawner function for the grader subagent. Injected by the caller (phases.ts /
 *  lifecycle.ts) which has access to ExtensionAPI + AgentManager. */
export type GraderSpawner = (prompt: string) => Promise<GraderSubagentResult>

/** Parse the subagent's response into a grade result. Scans for a JSON object
 *  with a valid grade field anywhere in the text — the subagent may produce
 *  the grade JSON in an earlier turn and then continue with follow-up text.
 *  Returns undefined if no parseable grade JSON is found. */
function parseGraderResponse(text: string): GradedResult | undefined {
	// Try parsing the full text as JSON first (common case: final message IS the JSON)
	const direct = tryParseJson<GradeJson>(text)
	if (direct !== undefined && isGrade(direct.grade)) {
		return buildGradedResult(direct)
	}

	// Scan for a JSON object containing a grade field anywhere in the text.
	// Uses a brace-balanced scan instead of a regex so that nested braces in
	// rationale strings or recommendations don't cause false negatives.
	const gradeJsons = extractJsonObjects(text)
	// Try from the last match (most recent grade)
	for (let i = gradeJsons.length - 1; i >= 0; i--) {
		const parsed = tryParseJson<GradeJson>(gradeJsons[i])
		if (parsed !== undefined && isGrade(parsed.grade)) {
			return buildGradedResult(parsed)
		}
	}

	return undefined
}

/** Shape of the grader's JSON output. charter_verdicts is journey-only: the
 *  ship-level charter audit the completion grader emits when an intent
 *  charter was provided. */
type GradeJson = { grade?: string; rationale?: string; recommendations?: unknown; charter_verdicts?: unknown }

/** Shared result type for both phase and journey grade parsing. */
type GradedResult = {
	ok: true
	grade: Grade
	rationale: string
	recommendations: string[]
	charterVerdicts?: CharterClauseVerdict[]
}

/** Coerce the model's `charter_verdicts` field into clean verdict rows.
 *  Accepts only well-formed {clause, status, evidence} objects with a real
 *  status; silently drops everything else (judge output is unreliable JSON).
 *  Caps 12 entries to bound the persisted payload. */
function normalizeCharterVerdicts(raw: unknown): CharterClauseVerdict[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const rows: CharterClauseVerdict[] = []
	for (const item of raw) {
		if (!item || typeof item !== "object") continue
		const o = item as Record<string, unknown>
		const clause = typeof o.clause === "string" ? o.clause.trim() : ""
		const evidence = typeof o.evidence === "string" ? o.evidence.trim() : ""
		const status = o.status === "met" || o.status === "waived" || o.status === "unmet" ? o.status : undefined
		if (!clause || !evidence || !status) continue
		rows.push({ clause: clause.slice(0, 200), status, evidence: evidence.slice(0, 400) })
		if (rows.length >= 12) break
	}
	return rows.length > 0 ? rows : undefined
}

/** Build a GradedResult from parsed JSON. */
function buildGradedResult(parsed: GradeJson): GradedResult {
	const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 800) : "(no rationale provided)"
	const recommendations = normalizeRecommendations(parsed.recommendations)
	const charterVerdicts = normalizeCharterVerdicts(parsed.charter_verdicts)
	return {
		ok: true,
		grade: parsed.grade as Grade,
		rationale,
		recommendations,
		...(charterVerdicts ? { charterVerdicts } : {}),
	}
}

/** Extract all top-level JSON objects from a text string using a
 *  brace-balanced scan. Handles nested braces inside strings and values. */
function extractJsonObjects(text: string): string[] {
	const results: string[] = []
	let i = 0
	while (i < text.length) {
		const open = text.indexOf("{", i)
		if (open === -1) break
		let depth = 0
		let inString = false
		let escaped = false
		let end = -1
		for (let j = open; j < text.length; j++) {
			const ch = text[j]
			if (inString) {
				if (escaped) {
					escaped = false
				} else if (ch === "\\") {
					escaped = true
				} else if (ch === '"') {
					inString = false
				}
			} else {
				if (ch === '"') inString = true
				else if (ch === "{") depth++
				else if (ch === "}") {
					depth--
					if (depth === 0) {
						end = j
						break
					}
				}
			}
		}
		if (end !== -1) {
			results.push(text.slice(open, end + 1))
			i = end + 1
		} else {
			i = open + 1
		}
	}
	return results
}

/** Grade a phase using a subagent with tool access. Falls back to the
 *  single-shot judgeApiCall() when the subagent is unavailable or fails. */
export async function judgePhaseGradeViaSubagent(
	input: JudgePhaseInput,
	spawn: GraderSpawner | undefined,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<JudgePhaseGradeResult> {
	// Try the subagent first if a spawner was provided. Retry once on
	// abort/error before going blind — run 019ff5cc had phases 2 and 4 accept
	// blind fallback grades (B and C) that a tool-equipped grader would likely
	// have refused, because a single killed grader spawn short-circuited to
	// the fallback on the first try.
	if (spawn) {
		const prompt = buildPhaseGraderPrompt(input)
		for (let attempt = 1; attempt <= 2; attempt++) {
			let retryableFailure = false
			try {
				const result = await spawn(prompt)
				// "steered" is a designed success state: the grader hit its soft turn
				// cap but wrapped up in time — exactly what thorough graders (which
				// re-run the whole verification matrix) do. Rejecting it used to
				// silently discard the best-evidenced verdicts in the run.
				if (result.status === "completed" || result.status === "steered") {
					const parsed = parseGraderResponse(result.text)
					if (parsed) return { ...parsed, graderSource: "subagent" as const }
					// Completed but output wasn't parseable — single-shot fallback,
					// no retry (a liveness retry wouldn't fix a parse issue).
				} else {
					// Aborted/errored — retry once with a fresh spawn.
					retryableFailure = true
				}
			} catch {
				// Subagent threw — retry once with a fresh spawn.
				retryableFailure = true
			}
			if (!retryableFailure) break
		}
	}

	// Fallback: single-shot LLM call.
	const fallback = await judgePhaseGrade(input, apiCall)
	return fallback.ok ? { ...fallback, graderSource: "fallback_single_shot" as const } : fallback
}

/** Grade a ferment (journey) using a subagent with tool access. Falls back to
 *  the single-shot judgeApiCall() when the subagent is unavailable or fails.
 *
 *  Retries the subagent ONCE on abort/error before going blind: measured run
 *  019ff5cc completed a flagship benchmark with journey grade=None because the
 *  single journey grader was killed by its duration cap mid-investigation and
 *  the fallback judge (no tools, charter-unverified) still said gates pass —
 *  silently voiding the ferment's most important quality checkpoint. A fresh
 *  spawn is cheap relative to a wrong ship verdict; the single-shot fallback
 *  remains as the last resort. */
export async function judgeJourneyGradeViaSubagent(
	input: JudgeJourneyGradeInput,
	spawn: GraderSpawner | undefined,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<JudgeJourneyGradeResult> {
	if (spawn) {
		const prompt = buildJourneyGraderPrompt(input)
		for (let attempt = 1; attempt <= 2; attempt++) {
			let retryableFailure = false
			try {
				const result = await spawn(prompt)
				// "steered" is a designed success state — see judgePhaseGradeViaSubagent.
				if (result.status === "completed" || result.status === "steered") {
					const parsed = parseGraderResponse(result.text)
					if (parsed) {
						if (input.charter && !parsed.charterVerdicts) {
							// Charter audit required but the subagent omitted it — fall
							// through to the single-shot fallback, which retries for it
							// (soft degrade after attempts are exhausted).
						} else return { ...parsed, graderSource: "subagent" as const }
					}
					// Completed but output wasn't parseable — single-shot fallback,
					// no retry (a liveness retry wouldn't fix a parse issue).
				} else {
					// Aborted/errored — retry once with a fresh spawn.
					retryableFailure = true
				}
			} catch {
				// Subagent threw — retry once with a fresh spawn.
				retryableFailure = true
			}
			if (!retryableFailure) break
		}
	}

	// Fallback: single-shot LLM call.
	const fallback = await judgeJourneyGrade(input, apiCall)
	return fallback.ok ? { ...fallback, graderSource: "fallback_single_shot" as const } : fallback
}

/** Build the user-message prompt for the phase grader subagent. This is the
 *  same content as buildPhaseGradeUserMsg but framed as a task instruction for
 *  a multi-turn agent rather than a single-shot completion. */
function buildPhaseGraderPrompt(input: JudgePhaseInput): string {
	const parts: string[] = []
	parts.push("You are grading a completed phase of an autonomous coding ferment.")
	parts.push("Verify the agent's claims independently using your tools, then produce a grade as JSON.")
	if (input.priorRefusal) {
		parts.push("")
		for (const line of renderPriorRefusalSection(input.priorRefusal, "this phase")) parts.push(line)
	}
	parts.push("")
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Phase: "${input.phaseName}"`)
	parts.push(`Phase goal: ${input.phaseGoal || "(none specified)"}`)
	if (input.charter) {
		parts.push("")
		parts.push(renderCharterFull(input.charter))
	}
	parts.push(`Phase summary: ${input.phaseSummary || "(none)"}`)
	if (input.stepSummaries && input.stepSummaries.trim().length > 0) {
		parts.push("")
		parts.push("Step summaries:")
		parts.push(input.stepSummaries)
	}
	parts.push("")
	parts.push("Phase-scope gate verdicts (agent self-reported — verify independently):")
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
		parts.push("(No diff available — use your tools to inspect files directly.)")
	}
	if (input.evidence && input.evidence.trim().length > 0) {
		parts.push("")
		parts.push("--- EXECUTION EVIDENCE (agent-provided) ---")
		parts.push(input.evidence.slice(0, 4000))
	}
	parts.push("")
	parts.push(`Working directory: ${process.cwd()}`)
	parts.push("")
	parts.push(RECOMMENDATION_CONTRACT)
	if (input.stepVerificationRuns && input.stepVerificationRuns.trim().length > 0) {
		parts.push("")
		parts.push("--- STEP VERIFICATION RUNS (executed by the harness) ---")
		parts.push(input.stepVerificationRuns)
	}
	parts.push(...renderEvidenceTrustPolicy(input.stepVerificationRuns))
	parts.push("")
	parts.push(
		"Verify the agent's claims by reading files and running commands. Then respond with EXACTLY one JSON object:",
	)
	parts.push('{"grade":"A"|"B"|"C"|"D"|"F","rationale":"...","recommendations":[...]}')
	return parts.join("\n")
}

/** Build the user-message prompt for the journey grader subagent. */
function buildJourneyGraderPrompt(input: JudgeJourneyGradeInput): string {
	const parts: string[] = []
	parts.push(
		"You are grading a completed ferment (all phases done). Verify the agent's claims independently using your tools, then produce a grade as JSON.",
	)
	if (input.priorRefusal) {
		parts.push("")
		for (const line of renderPriorRefusalSection(input.priorRefusal, "the ferment")) parts.push(line)
	}
	parts.push("")
	parts.push(`Ferment: "${input.fermentName}"`)
	parts.push(`Goal: ${input.goal || "(none specified)"}`)
	if (input.charter) {
		parts.push("")
		parts.push(renderCharterFull(input.charter))
	}
	parts.push(`Success criteria: ${input.successCriteria || "(none specified)"}`)
	parts.push(`Final summary: ${input.finalSummary || "(none)"}`)
	parts.push("")
	parts.push("Per-phase trail:")
	for (const p of input.phases) {
		parts.push(
			`  - Phase "${p.name}" [${p.status}] — ${p.goal}${p.grade ? ` — graded ${p.grade.grade} by phase grader` : ""}`,
		)
		if (!p.gateVerdicts || p.gateVerdicts.length === 0) {
			parts.push("    (no verdicts on file)")
		} else {
			for (const v of p.gateVerdicts) {
				parts.push(`    ${v.id} (${v.verdict}): ${v.rationale}`)
			}
		}
	}
	const certifiedPhases = input.phases.filter((p) => p.grade)
	if (certifiedPhases.length > 0) {
		parts.push("")
		parts.push("--- CERTIFIED PHASE VERDICTS — YOUR DELTA SCOPE ---")
		parts.push(
			"Every graded phase above was audited independently by a phase grader with tools (grades shown in the trail). Treat those verdicts as certified — do NOT re-audit phases line-by-line. Your ship-level job is what phase graders could not see: cross-phase integration, whole-ferment charter fulfillment, and breakage introduced between phases. Open a file only for a specific claim your charter audit cannot attest from the verdicts and evidence above.",
		)
	}
	parts.push("")
	parts.push("Ferment-scope gate verdicts (agent self-reported — verify independently):")
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
		parts.push("(No diff available — use your tools to inspect files directly.)")
	}
	if (input.stepVerificationRuns) {
		parts.push("")
		parts.push("--- HARNESS-EXECUTED VERIFICATION (deterministic re-run) ---")
		parts.push(input.stepVerificationRuns)
	}
	if (input.evidence && input.evidence.trim().length > 0) {
		parts.push("")
		parts.push("--- EXECUTION EVIDENCE (agent-provided) ---")
		parts.push(input.evidence.slice(0, 4000))
	}
	parts.push("")
	parts.push(...renderEvidenceTrustPolicy(input.stepVerificationRuns))
	parts.push(`Working directory: ${process.cwd()}`)
	parts.push("")
	parts.push(RECOMMENDATION_CONTRACT)
	parts.push("")
	parts.push(
		"Verify the agent's claims by reading files and running commands. Then respond with EXACTLY one JSON object:",
	)
	parts.push('{"grade":"A"|"B"|"C"|"D"|"F","rationale":"...","recommendations":[...]}')
	if (input.charter) {
		// Ship-level audit: this contract used to omit charter_verdicts entirely,
		// so subagent graders never emitted it (replay rule-4 miss). REQUIRED
		// whenever a charter is in play; both paths now enforce it.
		parts.push("")
		parts.push("An intent charter is in play above — also return charter_verdicts, one entry per charter clause:")
		parts.push(
			'"charter_verdicts":[{"clause":"<clause text, shortened>","status":"met"|"waived"|"unmet","evidence":"<what demonstrates it>"}]',
		)
		parts.push(
			'"unmet" = the finished artifact does not deliver that clause; "waived" = the deviation was explicitly accepted. REQUIRED — this is the ship-level charter audit.',
		)
	}
	return parts.join("\n")
}
