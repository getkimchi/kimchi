import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { SessionRow } from "./sessions-table.js"
import { formatRelativeTime } from "./sessions-table.js"

// ── Types ──────────────────────────────────────────────────────────

export type SessionPickerAction = "attach" | "connect" | "delete" | "kill-tmux" | "rename"

export interface SessionPickerResult {
	action: SessionPickerAction
	sessionId: string
	/** When attaching to a specific tmux session instead of the default "main". */
	tmuxSession?: string
}

// ── Internal row model ─────────────────────────────────────────────

interface DisplayRow {
	kind: "session" | "tmux"
	sessionId: string
	/** Only set for kind === "tmux" */
	tmuxName?: string
}

function buildDisplayRows(rows: SessionRow[]): DisplayRow[] {
	const result: DisplayRow[] = []
	for (const row of rows) {
		result.push({ kind: "session", sessionId: row.id })
		if (row.tmuxSessions) {
			for (const ts of row.tmuxSessions) {
				result.push({ kind: "tmux", sessionId: row.id, tmuxName: ts.name })
			}
		}
	}
	return result
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export class SessionsPanel implements Component {
	private selectedIndex = 0
	private now = new Date()
	private sessionMap: Map<string, SessionRow>
	private displayRows: DisplayRow[]
	private currentRows: SessionRow[]
	private _loading = false
	private _spinnerFrame = 0
	private _spinnerTimer?: ReturnType<typeof setInterval>

	constructor(
		rows: SessionRow[],
		private readonly tui: {
			requestRender(force?: boolean): void
			terminal: { rows: number; cols?: number }
		},
		private readonly done: (result: SessionPickerResult | undefined) => void,
	) {
		this.currentRows = rows
		this.sessionMap = new Map(rows.map((r) => [r.id, r]))
		this.displayRows = buildDisplayRows(rows)
	}

	/** Show or hide the loading spinner in the title bar. */
	set loading(value: boolean) {
		if (value === this._loading) return
		this._loading = value
		if (value) {
			this._spinnerTimer = setInterval(() => {
				this._spinnerFrame = (this._spinnerFrame + 1) % SPINNER_FRAMES.length
				this.tui.requestRender(true)
			}, 80)
		} else {
			if (this._spinnerTimer) {
				clearInterval(this._spinnerTimer)
				this._spinnerTimer = undefined
			}
			this.tui.requestRender(true)
		}
	}

	/**
	 * Replace the displayed rows with fresh data. Preserves the cursor
	 * position when possible (matches by session ID + tmux name).
	 */
	updateRows(rows: SessionRow[]): void {
		const prevDr = this.displayRows[this.selectedIndex]
		this.currentRows = rows
		this.sessionMap = new Map(rows.map((r) => [r.id, r]))
		this.displayRows = buildDisplayRows(rows)
		this.now = new Date()

		// Try to preserve selection.
		if (prevDr) {
			const newIdx = this.displayRows.findIndex(
				(dr) => dr.sessionId === prevDr.sessionId && dr.tmuxName === prevDr.tmuxName,
			)
			this.selectedIndex = newIdx >= 0 ? newIdx : Math.min(this.selectedIndex, this.displayRows.length - 1)
		} else {
			this.selectedIndex = 0
		}

		this.tui.requestRender(true)
	}

	// ── Keyboard ────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.displayRows.length === 0) {
			if (matchesKey(data, "escape") || matchesKey(data, "q")) this.done(undefined)
			return
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1)
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.displayRows.length - 1, this.selectedIndex + 1)
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, "a") || matchesKey(data, "return")) {
			const dr = this.displayRows[this.selectedIndex]
			this.done({
				action: "attach",
				sessionId: dr.sessionId,
				tmuxSession: dr.tmuxName,
			})
			return
		}
		if (matchesKey(data, "s")) {
			const dr = this.displayRows[this.selectedIndex]
			this.done({ action: "connect", sessionId: dr.sessionId })
			return
		}
		if (matchesKey(data, "shift+r")) {
			const dr = this.displayRows[this.selectedIndex]
			if (dr.kind === "session") {
				this.done({ action: "rename", sessionId: dr.sessionId })
			}
			return
		}
		if (matchesKey(data, "shift+d")) {
			const dr = this.displayRows[this.selectedIndex]
			if (dr.kind === "tmux" && dr.tmuxName) {
				this.done({ action: "kill-tmux", sessionId: dr.sessionId, tmuxSession: dr.tmuxName })
			} else if (dr.kind === "session") {
				this.done({ action: "delete", sessionId: dr.sessionId })
			}
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined)
		}
	}

	// ── Render ──────────────────────────────────────────────────────

	render(width: number): string[] {
		const rows = this.currentRows
		const { displayRows } = this
		const b = (s: string) => fg("2", s) // border color (dim)
		// Inner width = total width minus 2 border columns (│ left + │ right)
		const innerW = Math.max(20, width - 2)

		// Column widths (content sits inside the border with 1-char padding each side)
		const contentW = innerW - 2 // subtract left/right padding space
		const idWidth = rows.length > 0 ? Math.max(HEADERS.id.length, ...rows.map((r) => r.id.length)) : HEADERS.id.length
		const hostWidth =
			rows.length > 0
				? Math.max(HEADERS.host.length, ...rows.map((r) => (r.host ? r.host.split(".")[0] : "-").length))
				: HEADERS.host.length
		const statusWidth =
			rows.length > 0
				? Math.max(HEADERS.status.length, ...rows.map((r) => (r.status ?? "-").length))
				: HEADERS.status.length
		const lastWidth = HEADERS.lastActivity.length
		// prefix "> " / "  " = 2 chars
		const fixed = 2 + idWidth + 1 + hostWidth + 1 + 1 + statusWidth + 1 + lastWidth
		const longestName =
			rows.length > 0 ? Math.max(HEADERS.name.length, ...rows.map((r) => (r.name || "-").length)) : HEADERS.name.length
		const available = Math.max(MIN_NAME_WIDTH, contentW - fixed)
		const nameWidth = Math.min(longestName, available)

		const formatSessionRow = (row: SessionRow): string => {
			const id = pad(row.id, idWidth)
			const hostPrefix = row.host ? row.host.split(".")[0] : "-"
			const host = pad(hostPrefix, hostWidth)
			const name = pad(truncate(row.name || "-", nameWidth), nameWidth)
			const status = pad(row.status ?? "-", statusWidth)
			const lastActivity = row.lastActivityAt ? formatRelativeTime(row.lastActivityAt, this.now) : "-"
			return [id, host, name, status, lastActivity].join(" ")
		}

		const formatTmuxRow = (tmuxName: string, sessionRow: SessionRow): string => {
			const tmux = sessionRow.tmuxSessions?.find((t) => t.name === tmuxName)
			const attached = tmux?.attached ? " (attached)" : ""
			return `  ├─ ${tmuxName}${attached}`
		}

		// Wrap a text line inside border │ ... │, padded to innerW
		const row = (content: string) => `${b("│")} ${pad(content, contentW)} ${b("│")}`
		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const lines: string[] = []

		// Top border with title
		const spinner = this._loading ? ` ${SPINNER_FRAMES[this._spinnerFrame]}` : ""
		const titleText = ` Sessions${spinner} `
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

		// Empty state
		if (displayRows.length === 0) {
			const msg = this._loading ? "Loading sessions…" : "No remote sessions."
			lines.push(emptyRow())
			lines.push(ansiRow(dim(`  ${msg}`), msg.length + 2))
			lines.push(emptyRow())
			lines.push(b(`╰${"─".repeat(innerW)}╯`))
			return lines
		}

		// Scrolling
		const maxVisibleRows = Math.max(1, this.tui.terminal.rows - 8)
		const { start, end } = computeVisibleWindow(this.selectedIndex, displayRows.length, maxVisibleRows)

		if (start > 0) {
			lines.push(ansiRow(dim(`  ↑ ${start} more`), `  ↑ ${start} more`.length))
		}

		for (let i = start; i < end; i++) {
			const dr = displayRows[i]
			const sessionRow = this.sessionMap.get(dr.sessionId)
			if (!sessionRow) continue

			let content: string
			if (dr.kind === "tmux" && dr.tmuxName) {
				content = formatTmuxRow(dr.tmuxName, sessionRow)
			} else {
				content = formatSessionRow(sessionRow)
			}

			if (i === this.selectedIndex) {
				const raw = `> ${content}`
				lines.push(ansiRow(fg("36", raw), raw.length))
			} else {
				lines.push(row(`  ${content}`))
			}
		}

		if (end < displayRows.length) {
			lines.push(ansiRow(dim(`  ↓ ${displayRows.length - end} more`), `  ↓ ${displayRows.length - end} more`.length))
		}

		// Hint
		lines.push(emptyRow()) // spacing
		const hintText = "↑/↓ j/k: navigate  enter/a: attach  s: connect  R: rename  D: delete  esc: close"
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
		if (this._spinnerTimer) {
			clearInterval(this._spinnerTimer)
			this._spinnerTimer = undefined
		}
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
