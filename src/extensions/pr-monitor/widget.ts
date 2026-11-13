import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { safePanelText } from "../../components/input-panel.js"
import { prWatchFixesLabel, prWatchPlural, prWatchTargetLabel } from "./presentation.js"
import type { PRMonitorState } from "./types.js"

export function renderPRWatchWidget(state: PRMonitorState, width: number, theme: Theme): string[] {
	if (!state.enabled) return []
	if (state.watches && state.watches.length > 1) {
		const active = state.watches.filter(({ state }) => state.enabled)
		const repairing = active.find(({ state }) => state.phase === "fixing")?.state.pullRequest
		const attention = active.filter(({ state }) => state.phase === "attention" || state.phase === "error").length
		const status = repairing
			? `fixing ${repairing.repository} ${prWatchTargetLabel(repairing)}`
			: attention
				? `${attention} need attention`
				: state.phase === "attention"
					? "request needs attention"
					: "watching"
		return [
			truncateToWidth(
				`${theme.bold(theme.fg("text", `PR watch: ${active.length} ${prWatchPlural(state)}`))}${theme.fg("text", safePanelText(` · ${status}`))} · ${theme.fg("accent", "/pr-watch monitor")}`,
				Math.max(1, width),
				"…",
				true,
			),
		]
	}
	const pr = state.pullRequest
	const phase = state.phase === "attention" ? "needs attention" : state.phase
	const color = state.phase === "error" ? "error" : state.phase === "attention" ? "warning" : "text"
	const title = theme.bold(theme.fg(color, `${pr ? prWatchTargetLabel(pr) : "PR watch"}: ${phase}`))
	const counts =
		state.phase === "error"
			? "CI unavailable"
			: pr
				? `${pr.checks.length ? `${pr.checks.filter((check) => check.state === "failed").length} CI failing, ${pr.checks.filter((check) => check.state === "pending").length} running` : "CI unknown"} · review threads: ${pr.feedback.length}`
				: "discovering PR"
	const detail = width >= 90 ? ` · ${counts} · ${prWatchFixesLabel(state)}` : ""
	return [
		truncateToWidth(
			`${title}${theme.fg("text", safePanelText(detail))} · ${theme.fg("accent", "/pr-watch monitor")}`,
			Math.max(1, width),
			"…",
			true,
		),
	]
}
