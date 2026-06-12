import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

export function plainWidth(text: string): number {
	return visibleWidth(text.replace(ANSI_RE, ""))
}

export function truncateText(text: string, width: number): string {
	if (width <= 0) return ""
	if (plainWidth(text) <= width) return text
	if (width === 1) return "…"
	let out = ""
	for (const ch of Array.from(text)) {
		if (plainWidth(`${out}${ch}…`) > width) break
		out += ch
	}
	return `${out}…`
}

export function padText(text: string, width: number): string {
	const clipped = truncateText(text, width)
	const pad = Math.max(0, width - plainWidth(clipped))
	return `${clipped}${" ".repeat(pad)}`
}

export function panelLine(theme: Theme, width: number, text = "", focused = false): string {
	const contentWidth = Math.max(0, width - 2)
	const border = theme.fg(focused ? "borderAccent" : "border", "│")
	return `${border} ${padText(text, contentWidth)}`
}

export function divider(theme: Theme, width: number): string {
	return theme.fg("border", "─".repeat(Math.max(0, width)))
}

export function selectedLine(theme: Theme, text: string, width: number): string {
	return theme.bg("selectedBg", padText(text, width))
}

export function computeVisibleWindow(
	selected: number,
	total: number,
	maxVisible: number,
): { start: number; end: number } {
	if (maxVisible <= 0 || total <= 0) return { start: 0, end: 0 }
	if (total <= maxVisible) return { start: 0, end: total }
	const half = Math.floor(maxVisible / 2)
	let start = selected - half
	if (start < 0) start = 0
	if (start + maxVisible > total) start = total - maxVisible
	return { start, end: start + maxVisible }
}

export function formatRelativeTime(iso?: string, now = Date.now()): string {
	if (!iso) return "-"
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return "-"
	const seconds = Math.max(0, Math.floor((now - t) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h`
	return `${Math.floor(hours / 24)}d`
}

export function formatElapsed(startedAt?: string, completedAt?: string, now = Date.now()): string {
	if (!startedAt) return ""
	const start = Date.parse(startedAt)
	if (!Number.isFinite(start)) return ""
	const end = completedAt ? Date.parse(completedAt) : now
	if (!Number.isFinite(end)) return ""
	const seconds = Math.max(0, Math.floor((end - start) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ${minutes % 60}m`
	return `${Math.floor(hours / 24)}d`
}

export function compactId(id: string): string {
	return id.length <= 8 ? id : `${id.slice(0, 8)}…`
}
