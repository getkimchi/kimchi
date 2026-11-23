import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { safePanelText } from "../../components/input-panel.js"
import { overview } from "./presentation.js"
import type { PRWatchState } from "./types.js"

const DETAIL_MIN_WIDTH = 90

export function renderPRWatchWidget(state: PRWatchState, width: number, theme: Theme): string[] {
	const summary = overview(state)
	if (!summary) return []
	const title = theme.bold(theme.fg(summary.tone, `${summary.label}: ${summary.phase}`))
	const detail = width >= DETAIL_MIN_WIDTH ? ` · ${summary.message ?? `${summary.summary} · ${summary.fixes}`}` : ""
	const line = `${title}${theme.fg("text", safePanelText(detail))} · ${theme.fg("accent", "/pr-watch monitor")}`
	return [truncateToWidth(line, Math.max(1, width), "…", true)]
}
