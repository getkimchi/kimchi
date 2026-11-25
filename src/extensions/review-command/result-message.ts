import { homedir } from "node:os"
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
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
	baseDisplayRef?: string,
): ReviewResultDetails {
	return {
		branch: friendlyRef(scope.refs.head),
		base: friendlyRef(baseDisplayRef ?? scope.refs.resolvedBase),
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

function trailing(value: string, width: number): string {
	let result = ""
	for (const char of [...value].reverse()) {
		const candidate = char + result
		if (visibleWidth(candidate) > width) break
		result = candidate
	}
	return result
}

function middleTruncate(value: string, width: number, keepSuffix?: string): string {
	if (visibleWidth(value) <= width) return value
	if (width <= 1) return "…"
	const suffix = keepSuffix ?? trailing(value, Math.floor((width - 1) / 2))
	const available = width - visibleWidth(suffix) - 1
	if (available < 1) return truncateToWidth(value, width, "…")
	return `${truncateToWidth(value, available, "")}…${suffix}`
}

function fileLocation(finding: Pick<ReviewFindingRecord, "path" | "line">, width: number): string {
	const value = `${finding.path.replace(/^\.\//, "")}:${finding.line}`
	const tail = value.slice(value.lastIndexOf("/") + 1)
	const suffix = trailing(tail, Math.max(1, Math.floor(width / 2)))
	return middleTruncate(value, width, suffix)
}

function displayPath(value: string, width: number): string {
	const home = homedir()
	const shortened = value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
	return middleTruncate(shortened, width)
}

function firstSentence(description: string): string {
	let value = sanitizeReviewDisplayText(description)
	const boilerplate =
		/^(?:At (?:pinned )?head\s+[a-f\d]{40}(?:[a-f\d]{24})?[:,]?\s*|Revision\s+[a-f\d]{40}(?:[a-f\d]{24})?\.?\s*)/i
	for (;;) {
		const stripped = value.replace(boilerplate, "").trim()
		if (stripped === value) break
		value = stripped
	}
	if (!value) return "Review finding"
	return value.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? value
}

function shortenShas(value: string): string {
	return value.replace(/(?<![\w])([a-f\d]{64}|[a-f\d]{40})(?![\w])/gi, (sha) => sha.slice(0, 7))
}

function inlineText(value: string, theme: Theme | undefined): string {
	let result = ""
	let cursor = 0
	for (const match of value.matchAll(/`([^`\r\n]+)`/g)) {
		const index = match.index
		result += value.slice(cursor, index)
		result += theme ? theme.fg("accent", match[1]) : match[1]
		cursor = index + match[0].length
	}
	return result + value.slice(cursor)
}

function prose(value: string): string {
	return sanitizeReviewDisplayText(value)
}

function fitVisibleLine(value: string, width: number): string {
	const availableWidth = Math.max(1, width)
	return visibleWidth(value) <= availableWidth ? value : truncateToWidth(value, availableWidth, "…")
}

function findingPrefix(finding: ReviewFindingRecord): string {
	const icon = finding.priority === "P0" ? "✖" : priorityRank(finding.priority) <= 2 ? "▲" : "●"
	return `${icon} ${finding.priority} `
}

function findingColor(finding: ReviewFindingRecord): "error" | "warning" | "accent" {
	return finding.priority === "P0" ? "error" : priorityRank(finding.priority) <= 2 ? "warning" : "accent"
}

function findingHeader(finding: ReviewFindingRecord, theme: Theme | undefined, width: number): string {
	const label = findingPrefix(finding)
	const path = fileLocation(finding, width - 1 - visibleWidth(label))
	return ` ${theme ? theme.fg(findingColor(finding), label) : label}${theme ? theme.bold(path) : path}`
}

/** Compact or expanded presentation used only by the live TUI. */
export function renderReviewResultLines(
	details: ReviewResultDetails,
	theme: Theme | undefined,
	width: number,
	expanded = true,
	outputPad = 0,
): string[] {
	const safeWidth = Math.max(1, width - Math.max(0, outputPad))
	const line = (value: string) => (value ? `${" ".repeat(Math.max(0, outputPad))}${value}` : "")
	const summary = truncateToWidth(summaryLine(details), safeWidth, "…")
	const lines = [line(theme ? theme.fg(headlineColor(details), summary) : summary)]
	const partial = partialCoverageLine(details)
	if (partial) {
		lines.push("", ...wrap(partial, safeWidth).map((value) => line(theme ? theme.fg("warning", value) : value)))
	}
	if (details.findings.length > 0) lines.push("")
	for (const [index, finding] of sortedFindings(details.findings).entries()) {
		lines.push(line(findingHeader(finding, theme, safeWidth)))
		if (!expanded) {
			lines.push(line(fitVisibleLine(`  ${firstSentence(finding.description)}`, safeWidth)))
		} else {
			const bodyWidth = Math.max(1, Math.min(safeWidth, 100))
			const paragraphs = finding.description.split(/\r?\n\s*\r?\n/).filter((paragraph) => paragraph.trim())
			for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
				const content = inlineText(shortenShas(prose(paragraph)), theme)
				const rows = wrap(content, Math.max(1, bodyWidth - 4))
				for (const [rowIndex, row] of rows.entries()) {
					lines.push(line(`${rowIndex === 0 ? "  " : "    "}${row}`))
				}
				if (paragraphIndex < paragraphs.length - 1) lines.push(line(""))
			}
			if (finding.suggestion) {
				const label = "Fix: "
				const suggestion = inlineText(shortenShas(prose(finding.suggestion)), theme)
				const rows = wrap(suggestion, Math.max(1, bodyWidth - 2 - visibleWidth(label)))
				if (rows[0] !== undefined) {
					lines.push(line(`  ${theme ? theme.fg("dim", label) : label}${rows[0]}`))
				}
				for (const row of rows.slice(1)) lines.push(line(`       ${row}`))
			}
		}
		if (expanded && index < details.findings.length - 1) lines.push(line(""))
	}
	const toggle = expanded ? "ctrl+o to collapse details" : "ctrl+o to expand details"
	const path = displayPath(details.summaryPath, Math.max(1, safeWidth - visibleWidth(`${toggle} · report: `)))
	const footer = fitVisibleLine(`${toggle} · report: ${path}`, safeWidth)
	lines.push("", line(theme ? theme.fg("dim", footer) : footer))
	return lines
}

/** Legacy plaintext fallback for persistence and non-TUI consumers. */
function renderLegacyResultLines(details: ReviewResultDetails, theme: Theme | undefined, width: number): string[] {
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
	return renderLegacyResultLines(details, theme, Number.POSITIVE_INFINITY).join("\n")
}

export const reviewResultRenderer: MessageRenderer<ReviewResultDetails> = (message, options, theme) => {
	if (!message.details) return undefined
	const details = message.details
	return {
		render(width: number): string[] {
			return renderReviewResultLines(details, theme, Math.max(1, width), options.expanded, options.outputPad)
		},
		invalidate(): void {},
	}
}
