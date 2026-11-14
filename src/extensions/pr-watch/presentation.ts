import type { PRSnapshot, PRWatchState, TargetState } from "./types.js"

const SCOPES = { ci: "CI only", reviews: "reviews only", all: "CI + reviews" } as const
const CHECK_STATES = ["failed", "pending", "passed", "skipped"] as const
const WHITESPACE = " \t\n\r\v\f"

/** Splits on ASCII whitespace runs, dropping empty words. */
export function words(text: string): string[] {
	const found: string[] = []
	let word = ""
	for (const char of text) {
		if (!WHITESPACE.includes(char)) word += char
		else if (word) {
			found.push(word)
			word = ""
		}
	}
	if (word) found.push(word)
	return found
}

export function targetLabel(pr: Pick<PRSnapshot, "provider" | "number">): string {
	return `${pr.provider === "gitlab" ? "MR !" : "PR #"}${pr.number}`
}

export function targetName(target: TargetState): string {
	return target.pullRequest ? `${target.pullRequest.repository} ${targetLabel(target.pullRequest)}` : target.url
}

export function phaseLabel(target: TargetState): string {
	if (!target.enabled) return "Stopped"
	if (target.phase === "attention") return "Needs attention"
	if (target.phase === "error") return "Unavailable"
	return target.phase === "fixing" ? "Fixing" : "Watching"
}

export function fixesLabel(target: TargetState): string {
	if (!target.enabled) return "Auto-fix off"
	return target.autoFix ? `Auto-fix on · ${SCOPES[target.mode]}` : "Watch only"
}

export function ciSummary(target: TargetState): string {
	const pr = target.pullRequest
	if (!pr) return target.phase === "error" ? "CI unavailable" : "Checking the PR"
	const counts = CHECK_STATES.flatMap((state) => {
		const count = pr.checks.filter((check) => check.state === state).length
		return count ? [`${count} ${state === "pending" ? "running" : state}`] : []
	})
	const label = target.phase === "error" || !target.enabled ? "CI (last known)" : "CI"
	const ci = counts.length
		? `${label}: ${counts.join(" · ")}`
		: target.phase === "error"
			? "CI unavailable"
			: "CI unknown"
	return `${ci} · Review threads ${pr.feedback.length}`
}

export interface Overview {
	label: string
	phase: string
	tone: "error" | "warning" | "text"
	fixes: string
	summary: string
	message: string | null
}

function targetOverview(target: TargetState, message: string | null): Overview {
	return {
		label: target.pullRequest ? targetLabel(target.pullRequest) : "PR",
		phase: phaseLabel(target),
		tone: target.phase === "error" ? "error" : target.phase === "attention" ? "warning" : "text",
		fixes: fixesLabel(target),
		summary: ciSummary(target),
		message,
	}
}

function setOverview(watched: TargetState[], message: string | null): Overview {
	const fixing = watched.find((target) => target.phase === "fixing")
	const attention = watched.filter((target) => target.phase === "attention" || target.phase === "error").length
	const providers = new Set(watched.flatMap(({ pullRequest }) => (pullRequest ? [pullRequest.provider] : [])))
	const failing = watched.filter(({ pullRequest }) => pullRequest?.checks.some((check) => check.state === "failed"))
	const reviews = watched.reduce((sum, { pullRequest }) => sum + (pullRequest?.feedback.length ?? 0), 0)
	const fixed = watched.filter((target) => target.autoFix).length
	return {
		label: `${watched.length} ${providers.size > 1 ? "PRs/MRs" : providers.has("gitlab") ? "MRs" : "PRs"}`,
		phase: fixing ? `Fixing ${targetName(fixing)}` : attention ? `${attention} need attention` : "Watching",
		tone: attention ? "warning" : "text",
		fixes: fixed === watched.length ? "Auto-fix on" : fixed ? "Auto-fix on · some PRs" : "Watch only",
		summary: `CI failing on ${failing.length} · Review threads ${reviews}`,
		message,
	}
}

export function overview(state: PRWatchState): Overview | undefined {
	const watched = state.targets.filter((target) => target.enabled)
	if (watched.length === 1) return targetOverview(watched[0], state.message ?? watched[0].message)
	return watched.length ? setOverview(watched, state.message) : undefined
}

export function formatPRWatchStatus(state: PRWatchState): string {
	const summary = overview(state)
	const targets = state.targets.map((target) =>
		[
			target.pullRequest ? `${targetLabel(target.pullRequest)} ${target.pullRequest.title}` : null,
			target.url,
			`${phaseLabel(target)} · ${fixesLabel(target)}`,
			ciSummary(target),
			`Checkout: ${target.cwd}`,
			target.checkedAt ? `Last checked: ${target.checkedAt}` : null,
			target.message,
		]
			.filter(Boolean)
			.join("\n"),
	)
	const watching = state.targets.some((target) => target.enabled)
	return [
		summary ? `PR watch · ${summary.label} · ${summary.phase}` : "PR watch · Not watching",
		...targets,
		state.message,
		state.targets.some((target) => target.autoFix)
			? "Auto-fix may edit, test, commit and push under normal permissions, one PR at a time in this conversation."
			: null,
		watching ? "/pr-watch watch pauses fixes · /pr-watch stop stops watching · /pr-watch monitor shows details" : null,
		watching ? "Keep this Kimchi process open to keep watching." : null,
	]
		.filter(Boolean)
		.join("\n\n")
}
