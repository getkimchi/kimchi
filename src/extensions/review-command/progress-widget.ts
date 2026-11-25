import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Loader, type TUI, truncateToWidth } from "@earendil-works/pi-tui"
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

class ReviewActivityLoader extends Loader {
	frame(): string {
		return this.getRenderedIndicator()
	}
}

const activities = new WeakMap<ExtensionContext, ReviewActivityLoader>()

export function isReviewWidgetMounted(ctx: ExtensionContext): boolean {
	return activities.has(ctx)
}

export function stopReviewProgressAnimation(ctx: ExtensionContext): void {
	const loader = activities.get(ctx)
	activities.delete(ctx)
	loader?.stop()
}

export function mountReviewProgressComponent(
	ctx: ExtensionContext,
	ui: TUI,
	theme: Theme,
	model: () => ReviewProgressModel,
) {
	let loader = activities.get(ctx)
	if (!loader) {
		loader = new ReviewActivityLoader(
			ui,
			(frame) => theme.fg("accent", frame),
			(text) => text,
			"",
		)
		activities.set(ctx, loader)
	}
	return createReviewProgressComponent(theme, model, () => loader?.frame() ?? "◐")
}

function friendlyRef(value: string): string {
	return sanitizeReviewDisplayText(value.replace(/^refs\/(?:heads|remotes)\//, ""))
}

function issueCount(count: number, running: boolean): string {
	if (count <= 0) return running ? "" : "no issues"
	return `${count} issue${count === 1 ? "" : "s"}${running ? " so far" : ""}`
}

function stateColor(theme: Theme, state: StageState, text: string): string {
	if (state === "done") return theme.fg("success", text)
	if (state === "running") return theme.fg("warning", text)
	if (state === "failed") return theme.fg("error", text)
	return theme.fg("dim", text)
}

function stateIcon(state: StageState, indicator: () => string): string {
	return state === "running" ? indicator() : state === "failed" ? "✖" : state === "done" ? "●" : "○"
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

export function renderReviewProgress(
	model: ReviewProgressModel,
	theme: Theme,
	width: number,
	indicator: () => string = () => "◐",
): string[] {
	const safeWidth = Math.max(1, width)
	const scope = model.target.scope
	const progress = model.progress
	const branch = friendlyRef(scope.refs.head)
	const base = friendlyRef(model.target.baseDisplayRef ?? scope.refs.resolvedBase)
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
		const countLabel = count === "no issues" && state === "done" ? theme.fg("dim", count) : count
		const prefix = index === 0 ? "  1 Review   " : "             "
		const content = `${prefix}${stateIcon(state, indicator)} ${lens.id.padEnd(lensWidth)} ${stateText(state).padEnd(8)}${countLabel ? ` ${countLabel}` : ""}${reason ? ` ${reason}` : ""}`
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
			truncateToWidth(
				`  2 Merge    ${stateIcon(stages.merge, indicator)} dedupe & verify issues${mergeReason}`,
				safeWidth,
				"…",
			),
		),
		stateColor(
			theme,
			stages.report,
			truncateToWidth(
				`  3 Report   ${stateIcon(stages.report, indicator)} write findings${reportReason}`,
				safeWidth,
				"…",
			),
		),
	)
	return lines
}

export function createReviewProgressComponent(
	theme: Theme,
	model: () => ReviewProgressModel,
	indicator?: () => string,
) {
	return {
		render(width: number): string[] {
			return renderReviewProgress(model(), theme, width, indicator)
		},
		invalidate(): void {},
	}
}
