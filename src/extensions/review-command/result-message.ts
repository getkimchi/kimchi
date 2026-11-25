import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { ReviewFindingRecord, ReviewPanelResult } from "../review-panel/types.js"
import { sanitizeReviewDisplayText } from "../review-targets/provider-url.js"
import type { ResolvedReviewScope } from "../review-targets/types.js"

export const REVIEW_RESULT_CUSTOM_TYPE = "review-result"

export interface ReviewResultDetails {
	branch: string
	base: string
	findings: ReviewFindingRecord[]
	coverage: ReviewPanelResult["progress"]["coverage"]
	summaryPath: string
}

function friendlyRef(value: string): string {
	return sanitizeReviewDisplayText(value.replace(/^refs\/(?:heads|remotes)\//, ""))
}

export function reviewResultDetails(
	scope: ResolvedReviewScope,
	result: Pick<ReviewPanelResult, "progress" | "findings" | "summaryPath">,
): ReviewResultDetails {
	return {
		branch: friendlyRef(scope.refs.head),
		base: friendlyRef(scope.refs.resolvedBase),
		findings: result.findings,
		coverage: result.progress.coverage,
		summaryPath: result.summaryPath,
	}
}

const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const

type Priority = (typeof PRIORITIES)[number]

function priorityRank(priority: Priority): number {
	return PRIORITIES.indexOf(priority)
}

function sortedFindings(findings: readonly ReviewFindingRecord[]): ReviewFindingRecord[] {
	return [...findings].sort(
		(left, right) =>
			priorityRank(left.priority) - priorityRank(right.priority) ||
			left.path.localeCompare(right.path) ||
			left.line - right.line,
	)
}

function countByPriority(findings: readonly ReviewFindingRecord[], priority: Priority): number {
	return findings.filter((finding) => finding.priority === priority).length
}

function summaryLine(details: ReviewResultDetails): string {
	const total = details.findings.length
	const counts = PRIORITIES.map((priority) => ({ priority, count: countByPriority(details.findings, priority) }))
		.filter(({ count }) => count > 0)
		.map(({ priority, count }) => `${count} ${priority}`)
		.join(", ")
	const findingLabel =
		total === 0 ? "no findings" : `${total} finding${total === 1 ? "" : "s"}${counts ? ` (${counts})` : ""}`
	const comparison = `${details.branch} → ${details.base}`
	if (details.coverage.status === "partial" || details.coverage.unfinished_lenses.length > 0) {
		return details.coverage.submitted_lenses === 0
			? `✖ Review failed · ${findingLabel} · ${comparison}`
			: `▲ Review incomplete · ${findingLabel} · ${comparison}`
	}
	return `✔ Review done · ${findingLabel} · ${comparison}`
}

function headlineColor(details: ReviewResultDetails): "success" | "warning" | "error" {
	if (details.coverage.status !== "partial" && details.coverage.unfinished_lenses.length === 0) return "success"
	return details.coverage.submitted_lenses === 0 ? "error" : "warning"
}

function partialCoverageLine(details: ReviewResultDetails): string | undefined {
	if (details.coverage.status !== "partial" && details.coverage.unfinished_lenses.length === 0) return undefined
	const lenses = details.coverage.unfinished_lenses.join(", ")
	return `▲ Partial coverage: ${lenses || "one or more stages"} did not finish.`
}

function wrap(value: string, width: number): string[] {
	return Number.isFinite(width) ? wrapTextWithAnsi(value, Math.max(1, width)) : [value]
}

/** Render width-aware terminal rows, preserving continuation indentation and full paths. */
export function renderReviewResultLines(
	details: ReviewResultDetails,
	theme: Theme | undefined,
	width: number,
): string[] {
	const summary = summaryLine(details)
	const lines = wrap(theme ? theme.fg(headlineColor(details), summary) : summary, width)
	const partial = partialCoverageLine(details)
	if (partial) {
		lines.push("", ...wrap(theme ? theme.fg("warning", partial) : partial, width))
	}
	for (const finding of sortedFindings(details.findings)) {
		const color = finding.priority === "P0" ? "error" : priorityRank(finding.priority) <= 2 ? "warning" : "accent"
		const icon = finding.priority === "P0" ? "✖" : priorityRank(finding.priority) <= 2 ? "▲" : "●"
		const label = `${icon} ${finding.priority} `
		const path = `${finding.path}:${finding.line}`
		const marker = theme ? theme.fg(color, label) : label
		const pathLines = wrap(path, width - visibleWidth(` ${label}`))
		lines.push("", ` ${marker}${theme ? theme.bold(pathLines[0]) : pathLines[0]}`)
		for (const continuation of pathLines.slice(1)) {
			lines.push(`   ${theme ? theme.bold(continuation) : continuation}`)
		}
		for (const descriptionLine of wrap(finding.description, width - 3)) lines.push(`   ${descriptionLine}`)
		if (finding.suggestion) {
			const suggestionPrefix = "   Suggestion: "
			const suggestionLines = wrap(finding.suggestion, width - visibleWidth(suggestionPrefix))
			lines.push(
				theme
					? theme.fg("dim", `${suggestionPrefix}${suggestionLines[0]}`)
					: `${suggestionPrefix}${suggestionLines[0]}`,
			)
			for (const continuation of suggestionLines.slice(1)) {
				lines.push(theme ? theme.fg("dim", `   ${continuation}`) : `   ${continuation}`)
			}
		}
	}
	lines.push("", theme ? theme.fg("dim", " Report:") : " Report:")
	for (const reportLine of wrap(details.summaryPath, width - 2)) {
		lines.push(theme ? theme.fg("dim", `  ${reportLine}`) : `  ${reportLine}`)
	}
	return lines
}

export function renderReviewResult(details: ReviewResultDetails, theme?: Theme): string {
	return renderReviewResultLines(details, theme, Number.POSITIVE_INFINITY).join("\n")
}

export const reviewResultRenderer: MessageRenderer<ReviewResultDetails> = (message, _options, theme) => {
	if (!message.details) return undefined
	const details = message.details
	return {
		render(width: number): string[] {
			return renderReviewResultLines(details, theme, Math.max(1, width))
		},
		invalidate(): void {},
	}
}
