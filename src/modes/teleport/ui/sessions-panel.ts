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

		// Column widths
		const idWidth = Math.max(HEADERS.id.length, ...rows.map((r) => r.id.length))
		const hostWidth = Math.max(HEADERS.host.length, ...rows.map((r) => (r.host ? r.host.split(".")[0] : "-").length))
		const statusWidth = Math.max(HEADERS.status.length, ...rows.map((r) => (r.status ?? "-").length))
		const lastWidth = HEADERS.lastActivity.length
		// prefix "> " / "  " = 2 chars
		const fixed = 2 + idWidth + 1 + hostWidth + 1 + statusWidth + 1 + lastWidth
		const longestName = Math.max(HEADERS.name.length, ...rows.map((r) => (r.name || "-").length))
		const available = Math.max(MIN_NAME_WIDTH, width - fixed - 2)
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

		const lines: string[] = []

		// Title
		lines.push(dim(" Sessions"))
		lines.push("")

		// Header
		const header = [
			pad(HEADERS.id, idWidth),
			pad(HEADERS.host, hostWidth),
			pad(HEADERS.name, nameWidth),
			pad(HEADERS.status, statusWidth),
			HEADERS.lastActivity,
		].join(" ")
		lines.push(dim(`  ${header}`))

		// Scrolling
		// Reserve: title(1) + blank(1) + header(1) + blank(1) + hint(1) = 5
		// Plus up to 2 lines for scroll indicators
		const maxVisibleRows = Math.max(1, this.tui.terminal.rows - 7)
		const { start, end } = computeVisibleWindow(this.selectedIndex, rows.length, maxVisibleRows)

		if (start > 0) {
			lines.push(dim(`  ↑ ${start} more`))
		}

		for (let i = start; i < end; i++) {
			const row = rows[i]
			const content = formatRow(row)
			if (i === this.selectedIndex) {
				lines.push(fg("36", `> ${content}`))
			} else {
				lines.push(`  ${content}`)
			}
		}

		if (end < rows.length) {
			lines.push(dim(`  ↓ ${rows.length - end} more`))
		}

		// Footer
		lines.push("")
		lines.push(dim("  ↑/↓ j/k: navigate  a: attach  s: connect  esc: close"))

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
