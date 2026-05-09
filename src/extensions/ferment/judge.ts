/**
 * Judge — autonomous grading and verification.
 *
 * Uses kimchi's `complete()` from pi-ai with the kimchi-dev provider, always
 * targeting Claude Opus 4.7. The model handles are captured opportunistically
 * from any tool execute ctx (see state.captureJudgeContext).
 *
 * Roles:
 *  1. judgeStepVerification — non-zero exit at complete_step → pass/retry/fail
 *  2. judgeGradeStep        — graded after step completes (verified or summary-based)
 *  3. judgeGradePhase       — graded after complete_phase
 *  4. judgePlan             — sanity-check phases before execution starts
 *
 * computeFermentGrade aggregates phase grades into a final ferment grade.
 */

import { complete } from "@earendil-works/pi-ai"
import type { Delta, Grade, JudgeGrade, Phase } from "../../ferment/types.js"
import type { PhaseEvidence } from "./phase-evidence.js"
import { getJudgeModel, getJudgeModelRegistry } from "./state.js"

const JUDGE_MODEL_ID = "claude-opus-4-7"
const JUDGE_PROVIDER = "kimchi-dev"

async function judgeApiCall(systemPrompt: string, userMsg: string, maxTokens = 200): Promise<string | undefined> {
	const registry = getJudgeModelRegistry()
	if (!registry) return undefined

	const model = registry.find(JUDGE_PROVIDER, JUDGE_MODEL_ID) ?? getJudgeModel()
	if (!model) return undefined

	const auth = await registry.getApiKeyAndHeaders(model)
	if (!auth.ok || !auth.apiKey) return undefined

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
				signal: AbortSignal.timeout(30_000),
				maxTokens,
			},
		)

		return (
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim() || undefined
		)
	} catch {
		return undefined
	}
}

// Role 1 — Step verifier: called on non-zero bash exit at complete_step.

export interface JudgeVerdict {
	verdict: "pass" | "retry" | "fail"
	reason: string
}

export async function judgeStepVerification(
	stepDescription: string,
	verificationCommand: string,
	stdout: string,
	stderr: string,
	exitCode: number,
): Promise<JudgeVerdict> {
	const system = `You are a strict but fair verification judge for a coding agent. A step was marked complete but its verification command exited non-zero. Decide if this is a genuine failure, a transient/flaky issue worth retrying, or actually acceptable.

Respond with EXACTLY one JSON object, no markdown, no explanation:
{"verdict":"pass"|"retry"|"fail","reason":"<one sentence>"}

- pass: output is correct despite non-zero exit (grep returning 1 when no matches is expected, linter warnings only)
- retry: transient failure (network timeout, race condition, file not yet written)
- fail: genuine implementation error that must be fixed before continuing`

	const user = `Step: "${stepDescription}"\nVerification: \`${verificationCommand}\`\nExit: ${exitCode}\nstdout:\n${stdout.slice(0, 1000)}\nstderr:\n${stderr.slice(0, 1000)}`

	const raw = await judgeApiCall(system, user, 120)
	if (!raw) return { verdict: "fail", reason: "Judge unavailable — treating as failure." }
	try {
		const parsed = JSON.parse(raw) as { verdict?: string; reason?: string }
		const verdict = parsed.verdict === "pass" || parsed.verdict === "retry" ? parsed.verdict : "fail"
		return { verdict, reason: parsed.reason ?? raw }
	} catch {
		return { verdict: "fail", reason: raw.slice(0, 200) }
	}
}

// Role 2 — Step grader: called after a step successfully completes.

/**
 * Grade a completed step. When `evidence` is supplied (the diff between the
 * step's start ref and HEAD), the judge cross-checks the worker's summary
 * against the actual code change — same protocol as `judgeGradePhase`.
 *
 * Without evidence the grader sees only verification output + summary, which
 * is the same self-report failure mode the phase grader was upgraded to fix.
 */
export async function judgeGradeStep(
	stepDescription: string,
	summary: string,
	verificationResult?: { exitCode: number; stdout: string; stderr: string },
	evidence?: PhaseEvidence,
): Promise<JudgeGrade> {
	const system = `You are a code quality judge grading a completed step of a coding task.

You will be given:
1. The step description (what should have been done)
2. A worker-written summary (claim about what was done)
3. (When available) Verification command output (exit code, stdout, stderr)
4. (When available) Concrete code evidence: list of files changed since the step started and a truncated unified diff

When evidence is provided, **prioritize it over the summary**. If the summary claims work that the diff doesn't show, treat that as a "completeness" delta with severity major. If the diff shows work the summary doesn't acknowledge, treat that as a "scope" delta with severity minor.

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<one short sentence>","deltas":[{"category":"scope"|"quality"|"completeness"|"timing"|"correctness"|"other","expected":"<what should have happened>","actual":"<what actually happened>","severity":"major"|"minor"|"cosmetic"}]}

A = excellent, clean, fully verified
B = good, minor issues
C = adequate but notable gaps
D = barely acceptable, significant issues
F = failed or incomplete

Deltas are the gaps between expected and actual outcomes. Include only significant deltas (severity major or minor); omit cosmetic issues.`

	const verifyNote = verificationResult
		? `\nVerification exit: ${verificationResult.exitCode}\nstdout: ${verificationResult.stdout.slice(0, 400)}\nstderr: ${verificationResult.stderr.slice(0, 200)}`
		: ""
	const evidenceBlock = evidence?.available
		? `\n\n--- CODE EVIDENCE ---\nFiles changed:\n${evidence.filesChanged}${evidence.diffSnippet ? `\n\nDiff snippet:\n\`\`\`diff\n${evidence.diffSnippet}\n\`\`\`` : ""}`
		: ""
	const user = `Step: "${stepDescription}"\nSummary: ${summary || "(no summary)"}${verifyNote}${evidenceBlock}`

	const maxTokens = evidence?.available ? 300 : 150
	const raw = await judgeApiCall(system, user, maxTokens)
	const now = new Date().toISOString()
	// `unavailable: true` lets stats and the self-improvement loop distinguish
	// "judged B" from "judge couldn't be reached" — without this every judge
	// outage looks like a string of B grades and the loop never adapts.
	if (!raw) return { grade: "B", rationale: "Judge unavailable — assumed good.", gradedAt: now, unavailable: true }
	try {
		const parsed = JSON.parse(raw) as { grade?: string; rationale?: string; deltas?: unknown[] }
		const validGrades = ["A", "B", "C", "D", "F"]
		const grade = validGrades.includes(parsed.grade ?? "") ? (parsed.grade as Grade) : "B"

		let deltas: JudgeGrade["deltas"] = undefined
		if (Array.isArray(parsed.deltas) && parsed.deltas.length > 0) {
			deltas = parsed.deltas
				.filter(
					(d): d is { category: string; expected: string; actual: string; severity: string } =>
						typeof d === "object" &&
						d !== null &&
						"category" in d &&
						"expected" in d &&
						"actual" in d &&
						"severity" in d,
				)
				.map((d) => ({
					category: d.category as Delta["category"],
					expected: String(d.expected).slice(0, 200),
					actual: String(d.actual).slice(0, 200),
					severity: d.severity as Delta["severity"],
				}))
		}

		return { grade, rationale: parsed.rationale ?? raw.slice(0, 150), gradedAt: now, deltas }
	} catch {
		return { grade: "B", rationale: raw.slice(0, 150), gradedAt: now, unavailable: true }
	}
}

// Role 3 — Phase grader: called at complete_phase.

export async function judgeGradePhase(
	phaseName: string,
	phaseGoal: string,
	stepSummaries: string,
	summary: string,
	evidence?: PhaseEvidence,
): Promise<JudgeGrade> {
	const system = `You are a code quality judge grading a completed phase of a coding task.

You will be given:
1. The phase goal
2. Worker-written step summaries (claims about what was done)
3. A phase summary written by the planner
4. (When available) Concrete code evidence: list of files changed and a truncated unified diff

When evidence is provided, **prioritize it over the summary**. If the summary claims work that the diff doesn't show, treat that as a "completeness" delta with severity major. If the diff shows work the summary doesn't acknowledge, treat that as a "scope" delta with severity minor.

Respond with EXACTLY one JSON object, no markdown:
{"grade":"A"|"B"|"C"|"D"|"F","rationale":"<one short sentence>","deltas":[{"category":"scope"|"quality"|"completeness"|"timing"|"correctness"|"other","expected":"<what should have happened>","actual":"<what actually happened>","severity":"major"|"minor"|"cosmetic"}]}

A = phase goal fully achieved, clean implementation
B = goal mostly achieved, minor gaps
C = partial achievement, notable gaps
D = significant issues or incomplete
F = phase goal not achieved

Deltas are the gaps between expected and actual outcomes. Include only significant deltas (severity major or minor); omit cosmetic issues.`

	const evidenceBlock = evidence?.available
		? `\n\n--- CODE EVIDENCE ---\nFiles changed:\n${evidence.filesChanged}${evidence.diffSnippet ? `\n\nDiff snippet:\n\`\`\`diff\n${evidence.diffSnippet}\n\`\`\`` : ""}`
		: ""

	const user = `Phase: "${phaseName}"\nGoal: ${phaseGoal}\nStep summaries:\n${stepSummaries}\nPhase summary: ${summary || "(none)"}${evidenceBlock}`

	// Allow more tokens when evidence is provided — the judge has more material to compare.
	const maxTokens = evidence?.available ? 400 : 250
	const raw = await judgeApiCall(system, user, maxTokens)
	const now = new Date().toISOString()
	if (!raw) return { grade: "B", rationale: "Judge unavailable — assumed good.", gradedAt: now, unavailable: true }
	try {
		const parsed = JSON.parse(raw) as {
			grade?: string
			rationale?: string
			deltas?: unknown[]
		}
		const validGrades = ["A", "B", "C", "D", "F"]
		const grade = validGrades.includes(parsed.grade ?? "") ? (parsed.grade as Grade) : "B"

		// Parse deltas if present
		let deltas: JudgeGrade["deltas"] = undefined
		if (Array.isArray(parsed.deltas) && parsed.deltas.length > 0) {
			deltas = parsed.deltas
				.filter(
					(d): d is { category: string; expected: string; actual: string; severity: string } =>
						typeof d === "object" &&
						d !== null &&
						"category" in d &&
						"expected" in d &&
						"actual" in d &&
						"severity" in d,
				)
				.map((d) => ({
					category: d.category as Delta["category"],
					expected: String(d.expected).slice(0, 200),
					actual: String(d.actual).slice(0, 200),
					severity: d.severity as Delta["severity"],
				}))
		}

		return {
			grade,
			rationale: parsed.rationale ?? raw.slice(0, 150),
			gradedAt: now,
			deltas,
		}
	} catch {
		return { grade: "B", rationale: raw.slice(0, 150), gradedAt: now, unavailable: true }
	}
}

// Role 4 — Plan reviewer: called after scope_ferment to check phases before execution.

export interface PlanReview {
	verdict: "approve" | "revise"
	suggestions: string[]
	confidence: number // 0–100; 0 means the judge was unreachable / response unparseable
	reasoning: string
}

export async function judgePlan(
	fermentName: string,
	goal: string,
	criteria: string,
	constraints: string,
	phases: string,
): Promise<PlanReview> {
	const system = `You are a senior engineering lead reviewing a project plan before execution begins. Your job is to spot gaps, vague steps, and missing phases — NOT to rubber-stamp.

Respond with EXACTLY one JSON object, no markdown:
{"verdict":"approve"|"revise","suggestions":["..."],"reasoning":"<one sentence>","confidence":N}

# Verdict

- approve: every phase has a clear deliverable, every step is concrete and verifiable, the phases cover the full goal end-to-end, and there are no obvious blind spots.
- revise: any of the above is missing. Be picky.

# Confidence — pick ONE band, do NOT default to a round middle number

- 95: phases are crisp, steps are concrete and verifiable, scope matches the goal exactly, no gaps. Rare.
- 85: minor concerns (one phase a bit vague, or one obvious risk not called out) but the plan is sound.
- 70: meaningful gaps or concerns. Plan probably ships something useful but you can name 1-2 risks that could derail it.
- 55: significant concerns — phases are too high-level, or steps are descriptions rather than actions, or the plan is missing a phase.
- 35: plan is partly aspirational — the goal won't be reached as written.
- 15: not a plan, just a wish list.

Picking 75 or 80 because you're unsure means you didn't actually review it. If you can't justify a band, return "revise" with suggestions.

# Suggestions

Maximum 3 if revising. Each must be specific: name the phase or step that's weak and what would fix it. No generic advice.

# Reasoning

One sentence justifying the verdict and confidence. This is shown to the user.`

	const user = `Project: "${fermentName}"\nGoal: ${goal}\nSuccess criteria: ${criteria}\nConstraints: ${constraints}\n\nProposed phases:\n${phases}`

	const raw = await judgeApiCall(system, user, 400)
	if (!raw) return { verdict: "approve", suggestions: [], confidence: 0, reasoning: "Judge unavailable." }
	try {
		const parsed = JSON.parse(raw) as {
			verdict?: string
			suggestions?: unknown
			confidence?: number
			reasoning?: string
		}
		const verdict = parsed.verdict === "revise" ? "revise" : "approve"
		const suggestions = Array.isArray(parsed.suggestions)
			? (parsed.suggestions as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
			: []
		const confidence = typeof parsed.confidence === "number" ? Math.min(100, Math.max(0, parsed.confidence)) : 0
		const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 300) : ""
		return { verdict, suggestions, confidence, reasoning }
	} catch {
		return { verdict: "approve", suggestions: [], confidence: 0, reasoning: "Judge response unparseable." }
	}
}

// ─── Role 5 — Corrective-step suggester ──────────────────────────────────────
// Called when a phase grade is D or F. Asks the judge to propose a single
// concrete step the planner should add to the next phase to address the deltas.

/**
 * Ask the judge for one concrete corrective action given the previous phase's
 * deltas. Returns undefined when the judge is unreachable. Output is plain
 * text — a single sentence or short paragraph the planner can read.
 */
export async function judgeSuggestCorrectiveStep(
	phaseName: string,
	phaseGoal: string,
	grade: JudgeGrade,
): Promise<string | undefined> {
	const deltas = grade.deltas ?? []
	if (deltas.length === 0) return undefined

	const deltaList = deltas
		.map((d, i) => `  ${i + 1}. [${d.category}] expected: ${d.expected} | actual: ${d.actual} (${d.severity})`)
		.join("\n")

	const system = `You are a senior engineer suggesting a single corrective step to address gaps from a recently graded phase.

Respond with EXACTLY one JSON object, no markdown:
{"step":"<one concrete corrective step, ideally <120 chars>","rationale":"<one short sentence>"}

The step must be:
- Concrete and verifiable (no vague verbs like "improve" or "review")
- Bounded (something a worker can execute in one task)
- Targeted at the largest delta first`

	const user = `Phase: "${phaseName}"
Goal: ${phaseGoal}
Grade: ${grade.grade}
Rationale: ${grade.rationale}
Deltas:
${deltaList}`

	const raw = await judgeApiCall(system, user, 200)
	if (!raw) return undefined
	try {
		const parsed = JSON.parse(raw) as { step?: string; rationale?: string }
		if (!parsed.step) return undefined
		return parsed.rationale ? `${parsed.step}\n  Rationale: ${parsed.rationale}` : parsed.step
	} catch {
		return raw.slice(0, 200)
	}
}

// Aggregate phase grades into a final ferment grade.
//
// Skipped phases are excluded entirely; failed phases without grades count as F.
// This avoids the previous multiplicative-penalty bug that could go negative.

export function computeFermentGrade(phases: Phase[]): JudgeGrade {
	const gradeScore: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 }
	const relevant = phases.filter((p) => p.status !== "skipped")
	if (relevant.length === 0) {
		return { grade: "B", rationale: "No graded phases.", gradedAt: new Date().toISOString() }
	}
	const sum = relevant.reduce((acc, p) => {
		if (p.grade) return acc + gradeScore[p.grade.grade]
		if (p.status === "failed") return acc + gradeScore.F
		return acc
	}, 0)
	const counted = relevant.filter((p) => p.grade || p.status === "failed").length
	if (counted === 0) {
		return { grade: "B", rationale: "No graded phases.", gradedAt: new Date().toISOString() }
	}
	const avg = sum / counted
	const failedCount = phases.filter((p) => p.status === "failed").length
	const grade: Grade = avg >= 3.5 ? "A" : avg >= 2.5 ? "B" : avg >= 1.5 ? "C" : avg >= 0.5 ? "D" : "F"
	const failNote = failedCount > 0 ? `, ${failedCount} failed` : ""
	const rationale = `${counted} phase(s) counted, avg ${avg.toFixed(1)}/4${failNote}.`
	return { grade, rationale, gradedAt: new Date().toISOString() }
}
