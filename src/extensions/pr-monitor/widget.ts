import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { safePanelText } from "../../components/input-panel.js"
import type { PRMonitorState } from "./types.js"

export function renderPRWatchWidget(state: PRMonitorState, width: number, theme: Theme): string[] {
	if (!state.enabled) return []
	const pr = state.pullRequest
	const phase = state.phase === "attention" ? "needs attention" : state.phase
	const color = state.phase === "error" ? "error" : state.phase === "attention" ? "warning" : "accent"
	const title = theme.bold(theme.fg(color, `${pr ? `PR #${pr.number}` : "PR watch"}: ${phase}`))
	const counts =
		state.phase === "error"
			? "CI unavailable"
			: pr
				? `${pr.checks.length ? `${pr.checks.filter((check) => check.state === "failed").length} CI failing, ${pr.checks.filter((check) => check.state === "pending").length} running` : "CI unknown"} · review threads: ${pr.feedback.length}`
				: "discovering PR"
	const detail = width >= 90 ? ` · ${counts} · fixes ${state.autoFix ? "on" : "off"}` : ""
	return [
		truncateToWidth(
			`${title}${theme.fg("text", safePanelText(detail))} · ${theme.fg("accent", "/pr-watch monitor")}`,
			Math.max(1, width),
			"…",
			true,
		),
	]
}
