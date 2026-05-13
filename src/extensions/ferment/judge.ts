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
import { getJudgeModel, getJudgeModelRegistry } from "./state.js"

const JUDGE_MODEL_ID = "claude-opus-4-7"
const JUDGE_PROVIDER = "kimchi-dev"

const GRADES: Grade[] = ["A", "B", "C", "D", "F"]
export function isGrade(value: unknown): value is Grade {
	return typeof value === "string" && (GRADES as string[]).includes(value)
}

// ─── Low-level API call ───────────────────────────────────────────────────────
//
// Typed result so callers can distinguish "no registry / no model / no key"
// from "model call errored" from "model returned no text."

export type JudgeUnavailableReason = "no_registry" | "no_model" | "no_auth" | "api_error" | "empty_response"

export type JudgeApiResult = { ok: true; text: string } | { ok: false; reason: JudgeUnavailableReason; detail?: string }

export async function judgeApiCall(systemPrompt: string, userMsg: string, maxTokens = 400): Promise<JudgeApiResult> {
	const registry = getJudgeModelRegistry()
	if (!registry) return { ok: false, reason: "no_registry" }

	const model = registry.find(JUDGE_PROVIDER, JUDGE_MODEL_ID) ?? getJudgeModel()
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
				maxTokens,
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
