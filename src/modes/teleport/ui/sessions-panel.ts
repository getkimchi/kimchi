import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { SessionRow } from "./sessions-table.js"
import { formatRelativeTime } from "./sessions-table.js"

// ── Types ──────────────────────────────────────────────────────────

export type SessionPickerAction = "attach" | "connect"

export interface SessionPickerResult {
	action: SessionPickerAction
	sessionId: string
}

// ── Helpers ────────────────────────────────────────────────────────

function dim(s: string): string {
	return `\x1b[2m${s}\x1b[22m`
}

function pad(s: string, width: number): string {
	if (s.length >= width) return s
	return s + " ".repeat(width - s.length)
}

function truncate(s: string, width: number): string {
	if (s.length <= width) return s
	if (width <= 1) return s.slice(0, width)
	return `${s.slice(0, width - 1)}…`
}

function computeVisibleWindow(selected: number, total: number, maxVisible: number): { start: number; end: number } {
	if (total <= maxVisible) return { start: 0, end: total }
	const half = Math.floor(maxVisible / 2)
	let start = selected - half
	if (start < 0) start = 0
	if (start + maxVisible > total) start = total - maxVisible
	return { start, end: start + maxVisible }
}

// ── Column Headers ─────────────────────────────────────────────────

const HEADERS = {
	id: "ID",
	host: "HOST",
	name: "NAME",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
}

const MIN_NAME_WIDTH = 8

// ── Panel ──────────────────────────────────────────────────────────

export class SessionsPanel implements Component {
	private selectedIndex = 0
	private readonly now = new Date()

	constructor(
		private readonly rows: SessionRow[],
		private readonly tui: {
			requestRender(force?: boolean): void
			terminal: { rows: number; cols?: number }
		},
		private readonly done: (result: SessionPickerResult | undefined) => void,
	) {}

	// ── Keyboard ────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1)
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1)
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, "a")) {
			this.done({ action: "attach", sessionId: this.rows[this.selectedIndex].id })
			return
		}
		if (matchesKey(data, "s")) {
			this.done({ action: "connect", sessionId: this.rows[this.selectedIndex].id })
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined)
		}
	}

	// ── Render ──────────────────────────────────────────────────────

	render(width: number): string[] {
		const { rows } = this
		const b = (s: string) => fg("2", s) // border color (dim)
		// Inner width = total width minus 2 border columns (│ left + │ right)
		const innerW = Math.max(20, width - 2)

		// Column widths (content sits inside the border with 1-char padding each side)
		const contentW = innerW - 2 // subtract left/right padding space
		const idWidth = Math.max(HEADERS.id.length, ...rows.map((r) => r.id.length))
		const hostWidth = Math.max(HEADERS.host.length, ...rows.map((r) => (r.host ? r.host.split(".")[0] : "-").length))
		const statusWidth = Math.max(HEADERS.status.length, ...rows.map((r) => (r.status ?? "-").length))
		const lastWidth = HEADERS.lastActivity.length
		// prefix "> " / "  " = 2 chars
		const fixed = 2 + idWidth + 1 + hostWidth + 1 + statusWidth + 1 + lastWidth
		const longestName = Math.max(HEADERS.name.length, ...rows.map((r) => (r.name || "-").length))
		const available = Math.max(MIN_NAME_WIDTH, contentW - fixed)
		const nameWidth = Math.min(longestName, available)

		const formatRow = (row: SessionRow): string => {
			const id = pad(row.id, idWidth)
			const hostPrefix = row.host ? row.host.split(".")[0] : "-"
			const host = pad(hostPrefix, hostWidth)
			const name = pad(truncate(row.name || "-", nameWidth), nameWidth)
			const status = pad(row.status ?? "-", statusWidth)
			const lastActivity = row.lastActivityAt ? formatRelativeTime(row.lastActivityAt, this.now) : "-"
			return [id, host, name, status, lastActivity].join(" ")
		}

		// Wrap a text line inside border │ ... │, padded to innerW
		const row = (content: string) => `${b("│")} ${pad(content, contentW)}${b("│")}`
		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))}${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const lines: string[] = []

		// Top border with title
		const titleText = " Sessions "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		// Header
		const header = [
			pad(HEADERS.id, idWidth),
			pad(HEADERS.host, hostWidth),
			pad(HEADERS.name, nameWidth),
			pad(HEADERS.status, statusWidth),
			HEADERS.lastActivity,
		].join(" ")
		lines.push(ansiRow(dim(`  ${header}`), header.length + 2))

		// Divider under header
		lines.push(b(`├${"─".repeat(innerW)}┤`))

		// Scrolling
		// Reserve: top border(1) + header(1) + divider(1) + bottom border(1) + hint(1) + empty(1) = 6
		// Plus up to 2 for scroll indicators
		const maxVisibleRows = Math.max(1, this.tui.terminal.rows - 8)
		const { start, end } = computeVisibleWindow(this.selectedIndex, rows.length, maxVisibleRows)

		if (start > 0) {
			lines.push(ansiRow(dim(`  ↑ ${start} more`), `  ↑ ${start} more`.length))
		}

		for (let i = start; i < end; i++) {
			const content = formatRow(rows[i])
			if (i === this.selectedIndex) {
				const raw = `> ${content}`
				lines.push(ansiRow(fg("36", raw), raw.length))
			} else {
				lines.push(row(`  ${content}`))
			}
		}

		if (end < rows.length) {
			lines.push(ansiRow(dim(`  ↓ ${rows.length - end} more`), `  ↓ ${rows.length - end} more`.length))
		}

		// Hint
		emptyRow() // spacing
		const hintText = "↑/↓ j/k: navigate  a: attach  s: connect  esc: close"
		lines.push(ansiRow(dim(`  ${hintText}`), hintText.length + 2))

		// Bottom border
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	invalidate(): void {
		// no cached state
	}

	dispose(): void {
		// no timers or subscriptions
	}
}

// ── Factory ────────────────────────────────────────────────────────

export function createSessionsPanel(
	rows: SessionRow[],
	tui: { requestRender(force?: boolean): void; terminal: { rows: number; cols?: number } },
	done: (result: SessionPickerResult | undefined) => void,
): SessionsPanel & { dispose(): void } {
	return new SessionsPanel(rows, tui, done)
}
