import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { ResolvedReviewPanel, ReviewPanelProgress } from "../review-panel/index.js"
import type { ResolvedReviewTarget } from "../review-targets/index.js"
import { sanitizeReviewDisplayText } from "../review-targets/provider-url.js"

export interface ReviewProgressModel {
	target: ResolvedReviewTarget
	selection?: ResolvedReviewPanel
	progress?: ReviewPanelProgress
	error?: string
}

type StageState = "waiting" | "running" | "done" | "failed"

function friendlyRef(value: string): string {
	return sanitizeReviewDisplayText(value.replace(/^refs\/(?:heads|remotes)\//, ""))
}

function issueCount(count: number, running: boolean): string {
	if (count <= 0) return ""
	return `${count} issue${count === 1 ? "" : "s"}${running ? " so far" : ""}`
}

function stateColor(theme: Theme, state: StageState, text: string): string {
	if (state === "done") return theme.fg("success", text)
	if (state === "running") return theme.fg("warning", text)
	if (state === "failed") return theme.fg("error", text)
	return theme.fg("dim", text)
}

function stateIcon(state: StageState): string {
	return state === "running" ? "◐" : state === "failed" ? "✖" : state === "done" ? "●" : "○"
}

function stateText(state: StageState): string {
	return state
}

function stageStates(progress: ReviewPanelProgress | undefined, error: string | undefined) {
	if (!progress || progress.phase === "reviewing" || progress.phase === "reserve") {
		return { merge: "waiting", report: "waiting" } satisfies { merge: StageState; report: StageState }
	}
	if (progress.phase === "reconciling") {
		return {
			merge: error ? "failed" : "running",
			report: "waiting",
		} satisfies { merge: StageState; report: StageState }
	}
	if (progress.phase === "finalizing") {
		return { merge: "done", report: error ? "failed" : "running" } satisfies {
			merge: StageState
			report: StageState
		}
	}
	return { merge: "done", report: "done" } satisfies { merge: StageState; report: StageState }
}

function oneLine(value: string, maximum = 64): string {
	return truncateToWidth(value.replace(/\s+/g, " ").trim(), maximum, "…")
}

export function renderReviewProgress(model: ReviewProgressModel, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width)
	const scope = model.target.scope
	const progress = model.progress
	const branch = friendlyRef(scope.refs.head)
	const base = friendlyRef(scope.refs.resolvedBase)
	const fileNoun = scope.files.changed === 1 ? "file" : "files"
	const suffix = `  →  ${base}   (${scope.files.changed} ${fileNoun} · ${scope.pinned.headSha.slice(0, 7)})`
	const branchWidth = Math.max(1, Math.min(34, safeWidth - "Reviewing  ".length - suffix.length))
	const shortBranch = truncateToWidth(branch, branchWidth, "…")
	const header = `Reviewing  ${shortBranch}${suffix}`
	const lines = [theme.bold(truncateToWidth(header, safeWidth, "…"))]
	if (scope.pullRequest?.title) lines.push(truncateToWidth(`  ${scope.pullRequest.title}`, safeWidth, "…"))
	lines.push("")

	const selectedLenses = model.selection?.lenses ?? []
	const progressById = new Map(progress?.lenses.map((lens) => [lens.id, lens]) ?? [])
	const lensWidth = Math.max(12, ...selectedLenses.map((lens) => lens.id.length))
	selectedLenses.forEach((lens, index) => {
		const current = progressById.get(lens.id)
		const state: StageState =
			current?.status === "submitted"
				? "done"
				: current?.status === "running"
					? "running"
					: current?.status === "failed" || current?.status === "cancelled"
						? "failed"
						: "waiting"
		const reason =
			state === "failed"
				? oneLine(current?.error ?? (current?.status === "cancelled" ? "cancelled" : "failed"), 32)
				: ""
		const count = issueCount(current?.candidateCount ?? 0, state === "running" || state === "waiting")
		const prefix = index === 0 ? "  1 Review   " : "             "
		const content = `${prefix}${stateIcon(state)} ${lens.id.padEnd(lensWidth)} ${stateText(state).padEnd(8)}${count ? ` ${count}` : ""}${reason ? ` ${reason}` : ""}`
		lines.push(stateColor(theme, state, truncateToWidth(content, safeWidth, "…")))
	})
	if (selectedLenses.length === 0) lines.push(stateColor(theme, "waiting", "  1 Review   ○ waiting"))

	const stages = stageStates(progress, model.error)
	const mergeReason = stages.merge === "failed" && model.error ? ` ${oneLine(model.error, 32)}` : ""
	const reportReason = stages.report === "failed" && model.error ? ` ${oneLine(model.error, 32)}` : ""
	lines.push(
		stateColor(
			theme,
			stages.merge,
			truncateToWidth(`  2 Merge    ${stateIcon(stages.merge)} dedupe & verify issues${mergeReason}`, safeWidth, "…"),
		),
		stateColor(
			theme,
			stages.report,
			truncateToWidth(`  3 Report   ${stateIcon(stages.report)} write findings${reportReason}`, safeWidth, "…"),
		),
	)
	return lines
}

export function createReviewProgressComponent(theme: Theme, model: () => ReviewProgressModel) {
	return {
		render(width: number): string[] {
			return renderReviewProgress(model(), theme, width)
		},
		invalidate(): void {},
	}
}
