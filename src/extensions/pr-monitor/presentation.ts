import { PLAN_MODE_MESSAGE, type PRMonitorState, type PRSnapshot } from "./types.js"

export function prWatchTargetLabel(pr: Pick<PRSnapshot, "provider" | "number">): string {
	return `${pr.provider === "gitlab" ? "MR !" : "PR #"}${pr.number}`
}

export function prWatchPlural(state: PRMonitorState): string {
	const providers = new Set(
		(state.watches ?? [{ state }]).flatMap(({ state }) => (state.pullRequest ? [state.pullRequest.provider] : [])),
	)
	return providers.size > 1 ? "PRs/MRs" : providers.has("gitlab") ? "MRs" : "PRs"
}

export function prWatchPhaseLabel(state: PRMonitorState): string {
	if (!state.enabled) return "Stopped"
	if (state.phase === "attention") return "Needs attention"
	if (state.phase === "error") return "Unavailable"
	return state.phase === "fixing" ? "Fixing" : "Watching"
}

export function prWatchFixesLabel(state: PRMonitorState): string {
	if (!state.enabled) return "Auto-fix off"
	if (!state.autoFix) return "Watch only"
	if (state.message === PLAN_MODE_MESSAGE) return "Fixes paused in Plan"
	if (state.phase === "attention" || state.phase === "error") return "Auto-fix waiting"
	if (state.watches && state.watches.length > 1) {
		const active = state.watches.filter(({ state }) => state.enabled)
		if (active.some(({ state }) => !state.autoFix)) return "Auto-fix on · some PRs"
		if (new Set(active.map(({ state }) => state.mode)).size > 1) return "Auto-fix on · mixed scopes"
	}
	return `Auto-fix on${state.mode === "ci" ? " · CI only" : state.mode === "reviews" ? " · reviews only" : state.mode === "all" ? " · CI + reviews" : ""}`
}

export function prWatchSummary(state: PRMonitorState): string {
	if (state.watches && state.watches.length > 1) {
		const active = state.watches.filter(({ state }) => state.enabled)
		const failed = active.filter(({ state }) =>
			state.pullRequest?.checks.some((check) => check.state === "failed"),
		).length
		const unknown = active.filter(({ state }) => state.phase === "error" || !state.pullRequest?.checks.length).length
		const reviews = active.reduce((sum, { state }) => sum + (state.pullRequest?.feedback.length ?? 0), 0)
		return `CI: ${failed} PRs failing${unknown ? ` · ${unknown} unknown` : ""} · Review threads ${reviews}`
	}
	const pr = state.pullRequest
	if (!pr) return state.phase === "error" ? "CI unavailable" : "Looking for an open PR"
	const checks = pr.checks
	const counts = (["failed", "pending", "passed", "skipped"] as const).flatMap((status) => {
		const count = checks.filter((check) => check.state === status).length
		return count ? [`${count} ${status === "pending" ? "running" : status}`] : []
	})
	const label = state.phase === "error" || !state.enabled ? "CI (last known)" : "CI"
	const ci = checks.length
		? `${label}: ${counts.join(" · ")}`
		: state.phase === "error"
			? "CI unavailable"
			: "CI unknown"
	return `${ci} · Review threads ${pr.feedback.length}`
}
