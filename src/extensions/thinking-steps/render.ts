import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { deriveThinkingSteps } from "./parse.js"
import { getActiveThinkingState, getCurrentThinkingScopeKey, getThinkingStepsMode } from "./state.js"
import type { DerivedThinkingStep, ThinkingSemanticRole, ThinkingSourceBlock, ThinkingThemeLike } from "./types.js"

interface RenderOptions {
	mode: "collapsed" | "summary" | "expanded"
	steps: DerivedThinkingStep[]
	blocks: ThinkingSourceBlock[]
	activeStepId?: string
	isActive: boolean
	nowMs?: number
}

function roleColor(role: ThinkingSemanticRole): string {
	switch (role) {
		case "verify":
			return "success"
		case "error":
			return "error"
		case "compare":
			return "warning"
		case "inspect":
		case "search":
			return "mdLink"
		case "write":
		case "plan":
			return "accent"
		default:
			return "muted"
	}
}

function pulseGlyph(theme: ThinkingThemeLike, nowMs: number): string {
	const frames = [theme.fg("dim", "·"), theme.fg("muted", "•"), theme.fg("accent", "•"), theme.fg("muted", "•")]
	const frame = Math.floor(nowMs / 180) % frames.length
	return frames[frame] ?? frames[0]!
}

type InlineSegmentStyle = "plain" | "bold" | "code"

interface InlineSegment {
	text: string
	style: InlineSegmentStyle
}

function sanitizeThinkingText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
		.replace(/[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
		.replace(/\u001b(?:\[[0-?]*[ -\/]*[@-~]|[ -\/]*[0-9@-~])/g, "")
		.replace(/\u009b[0-?]*[ -\/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "")
}

function parseThinkingInlineSegments(text: string): InlineSegment[] {
	const sanitized = sanitizeThinkingText(text)
	const segments: InlineSegment[] = []
	const markerRe =
		/(\*\*|__)(?=\S)([\s\S]*?\S)\1|`([^`]+)`|(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])|(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g
	let lastIndex = 0
	for (const match of sanitized.matchAll(markerRe)) {
		const markerIndex = match.index ?? 0
		if (markerIndex > lastIndex) {
			segments.push({ text: sanitized.slice(lastIndex, markerIndex), style: "plain" })
		}
		if (match[2]) segments.push({ text: match[2], style: "bold" })
		if (match[3]) segments.push({ text: match[3], style: "code" })
		if (match[4]) segments.push({ text: match[4], style: "plain" })
		if (match[5]) segments.push({ text: match[5], style: "plain" })
		lastIndex = markerIndex + match[0].length
	}
	if (lastIndex < sanitized.length) {
		segments.push({ text: sanitized.slice(lastIndex), style: "plain" })
	}
	return segments
}

function renderThinkingInlineSegment(theme: ThinkingThemeLike, segment: InlineSegment): string {
	if (segment.style === "bold") return theme.bold(theme.fg("thinkingText", segment.text))
	if (segment.style === "code") return theme.bold(theme.fg("accent", segment.text))
	return theme.fg("thinkingText", segment.text)
}

function stepHeader(theme: ThinkingThemeLike, step: DerivedThinkingStep, active: boolean, connector: string): string {
	const connectorColor = active ? "accent" : "muted"
	const icon = theme.fg(roleColor(step.role), step.icon)
	const renderedSummary = renderThinkingInlineMarkup(theme, step.summary)
	const summaryText = active ? theme.bold(renderedSummary) : renderedSummary
	return `${theme.fg(connectorColor, connector)} ${icon} ${summaryText}`
}

function wrapStepHeader(
	theme: ThinkingThemeLike,
	width: number,
	step: DerivedThinkingStep,
	active: boolean,
	connector: string,
): string[] {
	const connectorColor = active ? "accent" : "muted"
	const icon = theme.fg(roleColor(step.role), step.icon)
	const prefix = `${theme.fg(connectorColor, connector)} ${icon} `
	const continuationPrefix = " ".repeat(visibleWidth(`${connector} ${step.icon} `))
	const renderedSummary = renderThinkingInlineMarkup(theme, step.summary)
	const summaryText = active ? theme.bold(renderedSummary) : renderedSummary
	const wrappedSummary = wrapTextWithAnsi(summaryText, Math.max(8, width - visibleWidth(prefix)))
	if (wrappedSummary.length === 0) {
		return [truncateToWidth(prefix, width, "")]
	}

	return wrappedSummary.map((line, index) =>
		truncateToWidth(`${index === 0 ? prefix : continuationPrefix}${line}`, width, ""),
	)
}

function pickCollapsedStep(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep | undefined {
	if (steps.length === 0) return undefined
	if (activeStepId) {
		const active = steps.find((step) => step.id === activeStepId)
		if (active) return active
	}

	let latestFailureIndex = -1
	let latestSuccessAfterFailureIndex = -1

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!
		if (step.hasExplicitFailure) {
			latestFailureIndex = index
			latestSuccessAfterFailureIndex = -1
		}
		if (latestFailureIndex !== -1 && step.hasExplicitSuccess && index > latestFailureIndex) {
			latestSuccessAfterFailureIndex = index
		}
	}

	if (latestSuccessAfterFailureIndex !== -1) return steps[latestSuccessAfterFailureIndex]
	if (latestFailureIndex !== -1) return steps[latestFailureIndex]

	return [...steps].sort(
		(left, right) =>
			(right.collapsedPriority ?? 0) - (left.collapsedPriority ?? 0) ||
			right.blockIndex - left.blockIndex ||
			right.stepIndex - left.stepIndex,
	)[0]!
}

function wrapCollapsedSummaryText(
	theme: ThinkingThemeLike,
	text: string,
	firstWidth: number,
	continuationWidth: number,
): string[] {
	const words = parseThinkingInlineSegments(text).flatMap((segment) =>
		segment.text
			.split(/\s+/)
			.filter(Boolean)
			.map((word) => renderThinkingInlineSegment(theme, { ...segment, text: word })),
	)
	if (words.length === 0) return []

	const lines: string[] = []
	let current = ""
	let currentWidth = Math.max(8, firstWidth)
	const continuationLineWidth = () => Math.max(8, continuationWidth)

	for (const word of words) {
		let pending = word
		while (pending.length > 0) {
			const candidate = current ? `${current} ${pending}` : pending
			if (visibleWidth(candidate) <= currentWidth) {
				current = candidate
				pending = ""
				continue
			}

			if (current) {
				lines.push(current)
				current = ""
				currentWidth = continuationLineWidth()
				continue
			}

			const wrappedWord = wrapTextWithAnsi(pending, currentWidth)
			if (wrappedWord.length === 0) {
				pending = ""
				continue
			}

			if (wrappedWord.length === 1) {
				current = wrappedWord[0] ?? ""
				pending = ""
				continue
			}

			lines.push(...wrappedWord.slice(0, -1))
			pending = wrappedWord[wrappedWord.length - 1] ?? ""
			currentWidth = continuationLineWidth()
		}
	}

	if (current) lines.push(current)
	return lines
}

function stripInlineFormattingMarkers(text: string): string {
	return text
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])/g, "$1")
		.replace(/(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g, "$1")
}

const COLLAPSED_LIVE_LINES = 5

function renderCollapsed(
	theme: ThinkingThemeLike,
	width: number,
	blocks: ThinkingSourceBlock[],
	steps: DerivedThinkingStep[],
	activeStepId?: string,
	isActive = false,
	nowMs = Date.now(),
): string[] {
	const step = pickCollapsedStep(steps, activeStepId)
	if (!step) return []

	const label = "Thinking"
	const icon = theme.fg(roleColor(step.role), step.icon)
	const activity = isActive ? pulseGlyph(theme, nowMs) : theme.fg("dim", "·")

	if (isActive) {
		const fullText = blocks
			.map((b) => b.text)
			.join("\n")
			.trim()
		if (fullText) {
			const headerPrefix = `${theme.fg("muted", "▍")} `
			const header = truncateToWidth(`${headerPrefix}${theme.fg("dim", label)} ${icon} ${activity}`, width, "")
			const bodyPrefix = `${theme.fg("muted", "▍")} `
			const allBodyLines = renderWrappedRawText(theme, fullText, width, bodyPrefix)
			const bodyLines = allBodyLines.slice(-COLLAPSED_LIVE_LINES)
			return [header, ...bodyLines]
		}
	}

	const activitySuffix = ` ${activity}`
	const activityWidth = visibleWidth(activitySuffix)
	const prefix = `${theme.fg("muted", "▍")} ${theme.fg("dim", label)} ${icon} `
	const continuationPrefix = `${theme.fg("muted", "▍")} ${" ".repeat(visibleWidth(`${label} ${step.icon} `))}`
	const summaryLines = wrapCollapsedSummaryText(
		theme,
		step.summary,
		Math.max(1, width - visibleWidth(prefix) - activityWidth),
		Math.max(1, width - visibleWidth(continuationPrefix) - activityWidth),
	)

	if (summaryLines.length <= 1) {
		return [
			truncateToWidth(
				`${prefix}${summaryLines[0] ?? renderThinkingInlineMarkup(theme, step.summary)}${activitySuffix}`,
				width,
				"",
			),
		]
	}

	return summaryLines.map((line, index) => {
		if (index === 0) return truncateToWidth(`${prefix}${line}`, width, "")
		if (index === summaryLines.length - 1)
			return truncateToWidth(`${continuationPrefix}${line}${activitySuffix}`, width, "")
		return truncateToWidth(`${continuationPrefix}${line}`, width, "")
	})
}

function stepHasEventType(step: DerivedThinkingStep, type: string): boolean {
	return step.summaryEvents?.some((event) => event.type === type) ?? false
}

function selectSummarySteps(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep[] {
	if (steps.length <= 5) return steps

	const indexed = steps.map((step, index) => ({ step, index }))
	const selected = new Set<number>()
	const activeIndex = activeStepId ? steps.findIndex((step) => step.id === activeStepId) : -1
	let latestFailureIndex = -1
	let latestSuccessAfterFailureIndex = -1

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!
		if (step.hasExplicitFailure) {
			latestFailureIndex = index
			latestSuccessAfterFailureIndex = -1
		}
		if (latestFailureIndex !== -1 && step.hasExplicitSuccess && index > latestFailureIndex) {
			latestSuccessAfterFailureIndex = index
		}
	}

	if (activeIndex !== -1) selected.add(activeIndex)
	if (latestFailureIndex !== -1) selected.add(latestFailureIndex)
	if (latestSuccessAfterFailureIndex !== -1) selected.add(latestSuccessAfterFailureIndex)

	const scoreEntry = ({ step, index }: { step: DerivedThinkingStep; index: number }): number => {
		let score = step.collapsedPriority ?? 0
		const isStaleSuccessBeforeLatestFailure =
			step.hasExplicitSuccess && latestFailureIndex !== -1 && index < latestFailureIndex
		if (index === latestFailureIndex && latestSuccessAfterFailureIndex === -1) score += 120
		if (index === latestSuccessAfterFailureIndex) score += 110
		if (stepHasEventType(step, "decision") || stepHasEventType(step, "plan_change")) score += 80
		if (step.hasExplicitFailure) score += 50
		if (step.hasExplicitSuccess && !isStaleSuccessBeforeLatestFailure) score += 45
		if (isStaleSuccessBeforeLatestFailure) score -= 200
		if (
			stepHasEventType(step, "focus") &&
			!stepHasEventType(step, "decision") &&
			!stepHasEventType(step, "plan_change") &&
			!step.hasExplicitFailure &&
			!step.hasExplicitSuccess
		)
			score -= 15
		return score + index / 100
	}

	const targetCount = Math.min(5, steps.length)
	for (const entry of [...indexed].sort((left, right) => scoreEntry(right) - scoreEntry(left))) {
		if (selected.size >= targetCount) break
		selected.add(entry.index)
	}

	return [...selected]
		.sort((left, right) => left - right)
		.map((index) => steps[index]!)
		.slice(0, targetCount)
}

function renderSummary(
	theme: ThinkingThemeLike,
	width: number,
	steps: DerivedThinkingStep[],
	activeStepId?: string,
): string[] {
	const lines = [truncateToWidth(`${theme.fg("muted", "▍")} ${theme.fg("dim", "Thinking Steps · Summary")}`, width)]
	const visibleSteps = selectSummarySteps(steps, activeStepId)
	for (let index = 0; index < visibleSteps.length; index++) {
		const step = visibleSteps[index]!
		const connector = index === visibleSteps.length - 1 ? "└─" : "├─"
		lines.push(...wrapStepHeader(theme, width, step, step.id === activeStepId, connector))
	}
	return lines
}

function renderThinkingInlineMarkup(theme: ThinkingThemeLike, text: string): string {
	const sanitized = sanitizeThinkingText(text)
	const segments = parseThinkingInlineSegments(sanitized)
	if (segments.length === 0) return theme.fg("thinkingText", sanitized)
	return segments.map((segment) => renderThinkingInlineSegment(theme, segment)).join("")
}

function renderThinkingDisplayLine(theme: ThinkingThemeLike, text: string): string {
	const headingMatch = text.match(/^(\s{0,3})#{1,6}\s+(.+)$/)
	if (headingMatch) {
		const indent = headingMatch[1] ?? ""
		const content = headingMatch[2] ?? ""
		return `${indent}${theme.bold(renderThinkingInlineMarkup(theme, content))}`
	}

	const listMatch = text.match(/^(\s*)([-*+]|\d+[.)]|[a-z][.)])\s+(.+)$/i)
	if (listMatch) {
		const indent = listMatch[1] ?? ""
		const marker = listMatch[2] ?? ""
		const content = listMatch[3] ?? ""
		const renderedMarker = /^[-*+]$/.test(marker) ? "•" : marker
		return `${indent}${theme.fg("muted", renderedMarker)} ${renderThinkingInlineMarkup(theme, content)}`
	}

	return renderThinkingInlineMarkup(theme, text)
}

function renderWrappedRawText(theme: ThinkingThemeLike, text: string, width: number, prefix: string): string[] {
	const innerWidth = Math.max(8, width - visibleWidth(prefix))
	const sanitizedText = sanitizeThinkingText(text)
	const rawLines = sanitizedText.replace(/\t/g, "    ").split("\n")
	const rendered: string[] = []
	for (const rawLine of rawLines) {
		if (rawLine.trim().length === 0) {
			rendered.push(truncateToWidth(prefix, width, ""))
			continue
		}
		const styled = renderThinkingDisplayLine(theme, rawLine)
		const wrapped = wrapTextWithAnsi(styled, innerWidth)
		for (const line of wrapped) {
			rendered.push(truncateToWidth(`${prefix}${line}`, width, ""))
		}
	}
	return rendered
}

function renderExpanded(
	theme: ThinkingThemeLike,
	width: number,
	steps: DerivedThinkingStep[],
	_activeStepId?: string,
): string[] {
	const prefix = `${theme.fg("muted", "▍")} `
	const lines: string[] = []

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!
		const normalizedBody = step.body.trim()
		if (!normalizedBody) continue

		if (index > 0) lines.push(theme.fg("muted", "▍"))
		lines.push(...renderWrappedRawText(theme, normalizedBody, width, prefix))
	}

	return lines
}

export function renderThinkingStepsLines(theme: ThinkingThemeLike, width: number, options: RenderOptions): string[] {
	if (options.steps.length === 0) return []
	if (options.mode === "collapsed") {
		return renderCollapsed(
			theme,
			width,
			options.blocks,
			options.steps,
			options.activeStepId,
			options.isActive,
			options.nowMs,
		)
	}
	if (options.mode === "expanded") {
		return renderExpanded(theme, width, options.steps, options.activeStepId)
	}
	return renderSummary(theme, width, options.steps, options.activeStepId)
}

export class ThinkingStepsComponent implements Component {
	private readonly blocks: ThinkingSourceBlock[]
	private steps: DerivedThinkingStep[]
	private cacheKey?: string
	private cachedLines?: string[]
	private readonly scopeKey: string

	constructor(
		private readonly theme: ThinkingThemeLike,
		private readonly messageTimestamp: number,
		blocks: ThinkingSourceBlock[],
		scopeKey?: string,
	) {
		this.blocks = blocks
		this.steps = deriveThinkingSteps(blocks)
		this.scopeKey = scopeKey ?? getCurrentThinkingScopeKey()
	}

	render(width: number): string[] {
		const mode = getThinkingStepsMode(this.scopeKey)
		const active = getActiveThinkingState(this.messageTimestamp, this.scopeKey)
		const activeStepId =
			active.active && active.contentIndex !== undefined
				? [...this.steps].reverse().find((step) => step.contentIndex === active.contentIndex)?.id
				: undefined
		const shouldBypassCache = mode === "collapsed" && active.active
		const nextCacheKey = `${width}:${mode}:${active.active ? 1 : 0}:${activeStepId ?? ""}`
		if (!shouldBypassCache && this.cachedLines && this.cacheKey === nextCacheKey) {
			return this.cachedLines
		}

		const innerWidth = Math.max(1, width - 1)
		const lines = renderThinkingStepsLines(this.theme, innerWidth, {
			mode,
			blocks: this.blocks,
			steps: this.steps,
			activeStepId,
			isActive: active.active,
			nowMs: Date.now(),
		}).map((line) => ` ${line}`)

		if (!shouldBypassCache) {
			this.cacheKey = nextCacheKey
			this.cachedLines = lines
		} else {
			this.cacheKey = undefined
			this.cachedLines = undefined
		}
		return lines
	}

	invalidate(): void {
		this.cacheKey = undefined
		this.cachedLines = undefined
	}
}
