/**
 * Session stage: what the session is doing right now, so the side loop can
 * surface only what matters at this point instead of an always-on dashboard.
 * Rules read the recent activity; d3 classifies the same digest when available.
 */
import { type ChoiceQuestion, type DecisionGateOptions, decide } from "../memory/decision-gate.js"
import type { SideLoopStats } from "./stats.js"
import type { SideSurface, SurfaceKind } from "./surface.js"

export type Stage = "exploring" | "implementing" | "verifying" | "shipping" | "reviewing" | "deploying"

export const STAGES: Record<Stage, string> = {
	exploring: "Reading code, searching, asking questions; nothing changed yet.",
	implementing: "Editing and writing files to make the requested change.",
	verifying: "Running tests, builds, linters or type checks on the change.",
	shipping: "Committing, pushing and opening a pull/merge request; waiting on CI.",
	reviewing: "Responding to review comments or CI failures on an open pull request.",
	deploying: "Rolling the change out: deploy, release, helm/kubectl, checking a live URL.",
}

/**
 * What each stage cares about. A card outside its stage's focus is parked (pane
 * only) unless it needs attention. Artifacts stay visible while fresh.
 */
export const STAGE_FOCUS: Record<Stage, SurfaceKind[]> = {
	exploring: ["artifact", "message"],
	implementing: ["changes", "tests", "artifact", "context"],
	verifying: ["tests", "changes", "context"],
	shipping: ["pr", "tests", "changes", "message"],
	reviewing: ["pr", "message", "tests"],
	deploying: ["deploy", "pr", "message"],
}

/** Fresh cards (created within this many prompts) stay in the dock regardless of stage. */
export const FRESH_PROMPTS = 2

export interface Activity {
	tool: string
	/** First words of a command, or the tool's target; never file contents. */
	detail: string
	ok: boolean
}

const ACTIVITY_LIMIT = 16

export class ActivityLog {
	private items: Activity[] = []

	push(activity: Activity): void {
		this.items = [...this.items, activity].slice(-ACTIVITY_LIMIT)
	}

	recent(): readonly Activity[] {
		return this.items
	}

	clear(): void {
		this.items = []
	}
}

export function describeActivity(tool: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>
	// Keep each chained segment's head: `git add -A && gh pr create --fill` must still read as shipping.
	if (typeof a.command === "string")
		return a.command
			.split(/&&|\|\||;|\|/)
			.map((segment) => segment.trim().split(/\s+/).slice(0, 3).join(" "))
			.filter(Boolean)
			.join(" · ")
			.slice(0, 100)
	if (typeof a.path === "string") return a.path.slice(-60)
	return tool
}

const DEPLOY =
	/\b(?:kubectl\s+(?:apply|rollout)|helm\s+(?:upgrade|install)|vercel|fly\s+deploy|netlify\s+deploy|gcloud\s+run\s+deploy)\b/
const SHIP = /\b(?:git\s+push|gh\s+pr\s+create|glab\s+mr\s+create)\b/
const REVIEW = /\b(?:gh\s+pr\s+(?:view|checks|comment|review)|glab\s+mr\s+(?:view|note))\b/
const VERIFY = /\b(?:test|vitest|jest|pytest|go\s+test|cargo\s+test|tsc|lint|build)\b/

/** The latest decisive activity wins; reading alone is exploring. */
export function ruleStage(activity: readonly Activity[], prs: number): Stage {
	for (const item of [...activity].reverse()) {
		if (DEPLOY.test(item.detail)) return "deploying"
		if (SHIP.test(item.detail)) return "shipping"
		if (REVIEW.test(item.detail)) return "reviewing"
		if (VERIFY.test(item.detail)) return "verifying"
		if (item.tool === "write" || item.tool === "edit") return prs ? "reviewing" : "implementing"
	}
	return prs ? "shipping" : "exploring"
}

const STAGE_QUESTION: ChoiceQuestion = {
	type: "choice",
	instructions:
		"state.activity is a coding agent's most recent tool calls (oldest first) for state.user_request; state.open_prs counts its open pull requests. Which stage is the session in now?",
	criteria: STAGES,
}

export async function classifyStage(
	gate: DecisionGateOptions | undefined,
	input: { prompt: string; activity: readonly Activity[]; prs: number },
	stats: SideLoopStats,
): Promise<{ stage: Stage; source: "d3" | "rule"; confidence?: number }> {
	const rule = ruleStage(input.activity, input.prs)
	if (!gate) {
		stats.decisions.ruleFallbacks++
		return { stage: rule, source: "rule" }
	}
	const started = performance.now()
	stats.decisions.calls++
	try {
		const state = JSON.stringify({
			user_request: input.prompt.slice(0, 600),
			activity: input.activity.map((a) => `${a.tool}: ${a.detail}${a.ok ? "" : " (failed)"}`),
			open_prs: input.prs,
		})
		const response = await decide(gate, state, { stage: STAGE_QUESTION })
		stats.decisions.inputTokens += response.usage.input_tokens
		const answer = response.answers.stage
		if (answer.confidence < 0.6 || !(answer.choice in STAGES)) {
			stats.decisions.ruleFallbacks++
			return { stage: rule, source: "rule" }
		}
		return { stage: answer.choice as Stage, source: "d3", confidence: answer.confidence }
	} catch {
		stats.decisions.failures++
		stats.decisions.ruleFallbacks++
		return { stage: rule, source: "rule" }
	} finally {
		stats.decisions.totalMs += performance.now() - started
	}
}

export type Placement = "dock" | "parked"

/** Where a card belongs at this stage. Pure. */
export function placement(surface: SideSurface, stage: Stage, prompt: number, tone: unknown): Placement {
	if (tone === "error") return "dock"
	if (prompt - (surface.bornAtPrompt ?? prompt) < FRESH_PROMPTS && surface.kind !== "changes") return "dock"
	return STAGE_FOCUS[stage].includes(surface.kind) ? "dock" : "parked"
}
