import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import type { Tab } from "./tab-manager.js"

export interface TabBarState {
	tabs: Tab[]
	activeIndex: number
}

const SEP = "\x1b[2m │ \x1b[22m"
const SEP_PLAIN = " │ "
const INV_OPEN = "\x1b[7m"
const INV_CLOSE = "\x1b[27m"
const DIM_OPEN = "\x1b[2m"
const DIM_CLOSE = "\x1b[22m"
const WARN_OPEN = "\x1b[33m"
const WARN_CLOSE = "\x1b[39m"
const NAME_MAX = 16

export class TabBar implements Component {
	constructor(private readonly getState: () => TabBarState) {}

	render(width: number): string[] {
		const { tabs, activeIndex } = this.getState()
		if (tabs.length === 0) return [pad("", width)]

		const labels = tabs.map((tab, i) => formatLabel(i, tab))
		const widths = labels.map((l) => visibleWidth(l.plain))
		const sepWidth = visibleWidth(SEP_PLAIN)

		const { start, end } = computeWindow(widths, sepWidth, activeIndex, width)

		let line = ""
		let usedWidth = 0
		if (start > 0) {
			const prefix = `${DIM_OPEN}…${DIM_CLOSE}`
			line += prefix
			usedWidth += 1
		}
		for (let i = start; i < end; i++) {
			if (i > start) {
				line += SEP
				usedWidth += sepWidth
			}
			const label = labels[i]
			if (i === activeIndex) {
				line += `${INV_OPEN}${label.styled}${INV_CLOSE}`
			} else {
				line += label.styled
			}
			usedWidth += widths[i]
		}
		if (end < tabs.length) {
			const suffix = `${DIM_OPEN}…${DIM_CLOSE}`
			line += suffix
			usedWidth += 1
		}

		const padCount = Math.max(0, width - usedWidth)
		return [line + " ".repeat(padCount)]
	}

	invalidate(): void {
		// Tab bar is fully derived from getState() each render; nothing to invalidate.
	}
}

function formatLabel(index: number, tab: Tab): { styled: string; plain: string } {
	const num = `${index + 1}`
	const name = truncate(tab.session.name, NAME_MAX)
	// Glyph precedence: degraded ⚠ > disconnected ○ > dirty • > clean.
	// "connecting" is treated as not-yet-degraded so the very first paint
	// doesn't flicker a warning glyph in before the connection establishes.
	// "disconnected" is the lazy state: tab exists for a workspace session
	// we haven't activated yet, so no WebSocket has been opened.
	const degraded =
		tab.connectionStatus !== "open" && tab.connectionStatus !== "connecting" && tab.connectionStatus !== "disconnected"
	if (degraded) {
		const plain = `⚠${num}:${name}`
		const styled = `${WARN_OPEN}⚠${WARN_CLOSE}${num}:${name}`
		return { styled, plain }
	}
	if (tab.connectionStatus === "disconnected") {
		const plain = `○${num}:${name}`
		const styled = `${DIM_OPEN}○${DIM_CLOSE}${num}:${name}`
		return { styled, plain }
	}
	const dirty = tab.dirty ? "•" : " "
	const plain = `${dirty}${num}:${name}`
	const styled = tab.dirty ? `${DIM_OPEN}•${DIM_CLOSE}${num}:${name}` : ` ${num}:${name}`
	return { styled, plain }
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	if (max <= 1) return s.slice(0, max)
	return `${s.slice(0, max - 1)}…`
}

function pad(s: string, width: number): string {
	const len = visibleWidth(s)
	if (len >= width) return s
	return s + " ".repeat(width - len)
}

function computeWindow(
	widths: number[],
	sepWidth: number,
	activeIndex: number,
	maxWidth: number,
): { start: number; end: number } {
	const total = widths.length
	if (total === 0) return { start: 0, end: 0 }

	// Pessimistic budget: reserve room for leading/trailing "…" markers so we
	// don't have to recompute after deciding to elide.
	const ellipsisReserve = 2
	const budget = Math.max(1, maxWidth - ellipsisReserve)

	// Expand outward from activeIndex until we run out of budget.
	let start = activeIndex
	let end = activeIndex + 1
	let used = widths[activeIndex] ?? 0

	while (used <= budget) {
		let extended = false
		if (end < total) {
			const next = sepWidth + widths[end]
			if (used + next <= budget) {
				used += next
				end += 1
				extended = true
			}
		}
		if (start > 0) {
			const prev = widths[start - 1] + sepWidth
			if (used + prev <= budget) {
				used += prev
				start -= 1
				extended = true
			}
		}
		if (!extended) break
	}

	return { start, end }
}
