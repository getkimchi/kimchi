/**
 * Ask-user primitive — the single decision-point routing layer.
 *
 * Replaces ad-hoc `ctx.ui?.select(...)` calls scattered across tool handlers
 * with one function that handles three audiences:
 *
 *   1. Interactive sessions (plan / exec / auto with a TUI attached) — routes
 *      to `ctx.ui.select`. The user picks; we return their choice.
 *   2. One-shot sessions (no human at the keyboard) — routes to an Opus judge
 *      that stands in for the user. The judge sees the ferment goal + success
 *      criteria + current phase/step + question + options, picks one with a
 *      rationale.
 *   3. Headless with no judge available — returns `{ failed: true }` and the
 *      caller is responsible for handling (typically by abandoning the
 *      ferment in one-shot mode).
 *
 * The agent-callable `ask_user` tool wraps this with a tool-error layer that
 * abandons the ferment when the judge can't be reached in one-shot mode.
 * Internal callers (plan-mode dropdowns, escalation, propose_phases) check
 * the `failed` flag and degrade gracefully.
 *
 * Detection of one-shot mode comes from the `ferment-oneshot` PI flag (set at
 * session boot by /ferment one-shot or --ferment-oneshot). There is no
 * `ferment.mode === "one-shot"` — modes are plan/exec/auto. The flag is
 * orthogonal.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ferment } from "../../ferment/types.js"
import { type JudgeApiResult, judgeApiCall } from "./judge.js"
import type { FermentRuntime } from "./runtime.js"
import type { FermentUi } from "./ui.js"

export interface AskUserOption {
	/** Stable id the agent (or judge) returns. */
	id: string
	/** Human-readable label shown in the TUI. */
	label: string
	/** Optional supporting context shown beneath the label and given to the
	 *  judge in one-shot mode. Keep it short. */
	description?: string
}

export type AskUserAnsweredBy = "user" | "judge"

export interface AskUserSuccess {
	failed?: false
	/** The selected option's `id`. */
	choice: string
	/** Who answered: "user" in interactive sessions, "judge" in one-shot. */
	answered_by: AskUserAnsweredBy
	/** Present when `answered_by === "judge"` — the model's one-line rationale. */
	rationale?: string
}

export interface AskUserFailure {
	failed: true
	/** Stable categorical reason so callers can branch / log uniformly. */
	reason: "no_ui_no_judge" | "judge_unavailable" | "judge_unparseable" | "user_cancelled" | "invalid_choice"
	/** Human-readable detail for inclusion in tool errors. */
	detail: string
}

export type AskUserResponse = AskUserSuccess | AskUserFailure

export interface AskUserContext {
	ferment: Ferment
	pi: ExtensionAPI
	/** TUI hook. Accepts `Partial<FermentUi>` (matches `StepUiContext` /
	 *  `PhaseUiContext`) — the only method we actually read is `select`. */
	ctx?: { ui?: Partial<FermentUi> }
	/** Optional. When provided, `askUser` calls `runtime.markHumanInput()`
	 *  on user-answered responses so downstream signals (nudge throttling,
	 *  planner-supplement freshness) reflect the interaction. */
	runtime?: Pick<FermentRuntime, "markHumanInput">
}

/** True when the current PI session is the one-shot planner — no human is
 *  attached, so any question must route to the judge. */
function isOneShotSession(pi: ExtensionAPI): boolean {
	return pi.getFlag?.("ferment-oneshot") === true
}

const ASK_USER_SYSTEM = `You are standing in for the user during an autonomous ferment run. A planner agent has reached a decision point it cannot resolve from context alone and is asking the user. There is no human available — you decide.

Your bias:
- Choose the option that best serves the ferment's stated goal and success criteria, NOT whatever moves work forward fastest.
- When two options seem equivalent, prefer the more conservative one (less destructive, more revertible).
- When you genuinely cannot tell which option is best, choose the option that explicitly preserves optionality (pause / revise / abandon).

You will be given:
- The ferment goal and success criteria.
- The current phase and step (when applicable).
- The question the agent is asking.
- The set of options, each with an id and a label (sometimes a description).

Return EXACTLY one JSON object, no markdown, no prose:
{"choice":"<option_id>","rationale":"<one sentence justifying the choice>"}

The "choice" MUST be one of the provided option ids verbatim. If you cannot in good faith pick any option, choose the option whose id contains "pause", "abandon", or "cancel" — falling back to the FIRST option only as a last resort.`

function buildAskJudgeUserMsg(question: string, options: ReadonlyArray<AskUserOption>, ferment: Ferment): string {
	const activePhase = ferment.phases.find((p) => p.status === "active")
	const activeStep = activePhase?.steps.find((s) => s.status === "running")
	const optionLines = options
		.map((o) => `  - id="${o.id}"  label="${o.label}"${o.description ? `  description="${o.description}"` : ""}`)
		.join("\n")
	const parts: string[] = []
	parts.push(`Ferment: "${ferment.name}"`)
	parts.push(`Goal: ${ferment.goal ?? "(none specified)"}`)
	parts.push(`Success criteria: ${ferment.successCriteria ?? "(none specified)"}`)
	if (activePhase) parts.push(`Active phase: ${activePhase.index}. "${activePhase.name}" — ${activePhase.goal}`)
	if (activeStep) parts.push(`Active step: ${activeStep.index}. "${activeStep.description}"`)
	parts.push("")
	parts.push(`Question: ${question}`)
	parts.push("")
	parts.push("Options:")
	parts.push(optionLines)
	return parts.join("\n")
}

function parseJudgeChoice(
	text: string,
	options: ReadonlyArray<AskUserOption>,
): { choice: string; rationale: string } | undefined {
	let s = text.trim()
	if (s.startsWith("```")) {
		s = s
			.replace(/^```[a-z]*\n?/i, "")
			.replace(/```$/, "")
			.trim()
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(s)
	} catch {
		const m = s.match(/\{[\s\S]*\}/)
		if (!m) return undefined
		try {
			parsed = JSON.parse(m[0])
		} catch {
			return undefined
		}
	}
	if (!parsed || typeof parsed !== "object") return undefined
	const obj = parsed as { choice?: unknown; rationale?: unknown }
	if (typeof obj.choice !== "string") return undefined
	// Validate the choice matches one of the offered option ids. This is
	// important — silently accepting a hallucinated id would route the agent
	// down an option it never offered.
	if (!options.some((o) => o.id === obj.choice)) return undefined
	const rationale = typeof obj.rationale === "string" ? obj.rationale : "(no rationale provided)"
	return { choice: obj.choice, rationale: rationale.slice(0, 400) }
}

/** Ask the judge as a stand-in user. Returns a structured success or a typed
 *  failure. Callers decide whether failure is fatal (one-shot mode) or
 *  recoverable (interactive degrade). */
export async function askJudge(
	question: string,
	options: ReadonlyArray<AskUserOption>,
	ferment: Ferment,
	apiCall: (sys: string, msg: string, maxTokens?: number) => Promise<JudgeApiResult> = judgeApiCall,
): Promise<AskUserResponse> {
	const userMsg = buildAskJudgeUserMsg(question, options, ferment)
	const result = await apiCall(ASK_USER_SYSTEM, userMsg, 200)
	if (!result.ok) {
		return {
			failed: true,
			reason: "judge_unavailable",
			detail: `Judge unreachable (${result.reason}${result.detail ? `: ${result.detail}` : ""}).`,
		}
	}
	const parsed = parseJudgeChoice(result.text, options)
	if (!parsed) {
		return {
			failed: true,
			reason: "judge_unparseable",
			detail: `Judge returned unparseable output: ${result.text.slice(0, 200)}`,
		}
	}
	return { choice: parsed.choice, answered_by: "judge", rationale: parsed.rationale }
}

/** Routing entry point. Picks the right audience for the question, returns
 *  a uniform response shape. Read the file header for the routing rules. */
export async function askUser(
	question: string,
	options: ReadonlyArray<AskUserOption>,
	context: AskUserContext,
	overrides?: { askJudge?: typeof askJudge },
): Promise<AskUserResponse> {
	if (options.length === 0) {
		return { failed: true, reason: "invalid_choice", detail: "askUser called with empty options array." }
	}

	const oneShot = isOneShotSession(context.pi)

	if (oneShot) {
		// One-shot: judge is the only legitimate audience. No fallback to TUI
		// even if a UI happens to be attached — the contract says one-shot
		// runs are unattended, and we don't want to half-prompt a CLI user.
		const judge = overrides?.askJudge ?? askJudge
		return judge(question, options, context.ferment)
	}

	// Interactive: route to TUI when available.
	const select = context.ctx?.ui?.select
	if (select) {
		const labels = options.map((o) => o.label)
		const chosenLabel = await select(question, labels)
		if (!chosenLabel) {
			return { failed: true, reason: "user_cancelled", detail: "User cancelled the prompt." }
		}
		const match = options.find((o) => o.label === chosenLabel)
		if (!match) {
			return {
				failed: true,
				reason: "invalid_choice",
				detail: `UI returned a label not in the options set: ${chosenLabel}`,
			}
		}
		// Side effect: mark human input so downstream signals (nudge throttling,
		// planner-supplement freshness) reflect that the user just interacted.
		// Skipped for judge-answered responses since no human was involved.
		context.runtime?.markHumanInput()
		return { choice: match.id, answered_by: "user" }
	}

	return {
		failed: true,
		reason: "no_ui_no_judge",
		detail: "No TUI attached and not in one-shot mode — cannot route the question to any audience.",
	}
}
