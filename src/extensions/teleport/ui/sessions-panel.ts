import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { TeleportContext } from "../types.js"
import type { CombinedStatus, SessionRow } from "./sessions-table.js"
import { formatRelativeTime } from "./sessions-table.js"

// Must match the maxHeight in the overlay options below. The panel sizes its
// scrollable viewport so that the bordered chrome fits inside maxHeight, and
// always emits the same line count regardless of selection, which keeps
// the pi-tui overlay compositor from shifting the chat content underneath.
const MAX_HEIGHT_PCT = 0.8

// Lines outside the scrollable body:
//   top border (1) + header (1) + divider (1)
//   + top scroll indicator (1) + bottom scroll indicator (1)
//   + empty row (1) + hint (1) + bottom border (1)
const CHROME_LINES = 8

export type SessionPickerAction = "open" | "delete"

export interface SessionPickerResult {
	action: SessionPickerAction
	row: SessionRow
}

interface PickerTui {
	requestRender(force?: boolean): void
	terminal: { rows: number; cols?: number }
}

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

const STATUS_LABEL: Record<CombinedStatus, string> = {
	active: "active",
	disconnected: "disconnected",
	idle: "idle",
	completed: "completed",
	unreachable: "unreachable",
}

function statusLabel(s: CombinedStatus): string {
	const text = STATUS_LABEL[s]
	switch (s) {
		case "active":
			return fg("36", text)
		case "disconnected":
			return fg("33", text)
		case "unreachable":
			return fg("31", text)
		case "idle":
		case "completed":
			return dim(text)
	}
}

const HEADERS = {
	session: "SESSION",
	workspace: "WORKSPACE",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
	client: "CLIENT",
}

const MIN_COL_WIDTH = 8

export class SessionsPanel implements Component {
	private selectedIndex = 0
	private readonly now = new Date()

	constructor(
		private readonly rows: SessionRow[],
		private readonly tui: PickerTui,
		private readonly done: (result: SessionPickerResult | undefined) => void,
	) {}

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
		if (matchesKey(data, "return")) {
			const row = this.rows[this.selectedIndex]
			if (!row || row.sessionName === "") return
			this.done({ action: "open", row })
			return
		}
		if (matchesKey(data, "d")) {
			const row = this.rows[this.selectedIndex]
			if (!row || row.sessionName === "") return
			this.done({ action: "delete", row })
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "x")) {
			this.done(undefined)
		}
	}

	render(width: number): string[] {
		const { rows } = this
		const b = (s: string) => fg("2", s)
		const innerW = Math.max(20, width - 2)
		const contentW = innerW - 2

		const sessionLabel = (r: SessionRow) => r.sessionName || "-"
		const lastLabel = (r: SessionRow) => (r.lastActivityAt ? formatRelativeTime(r.lastActivityAt, this.now) : "-")
		const clientLabel = (r: SessionRow) =>
			r.status === "unreachable" ? "-" : r.clientConnected ? "connected" : "disconnected"

		const sessionWidth = Math.max(HEADERS.session.length, ...rows.map((r) => sessionLabel(r).length))
		const workspaceWidth = Math.max(HEADERS.workspace.length, ...rows.map((r) => (r.workspaceName || "-").length))
		const statusWidth = Math.max(HEADERS.status.length, ...rows.map((r) => STATUS_LABEL[r.status].length))
		const lastWidth = Math.max(HEADERS.lastActivity.length, ...rows.map((r) => lastLabel(r).length))
		const clientWidth = Math.max(HEADERS.client.length, ...rows.map((r) => clientLabel(r).length))

		const fixedNoFlex = 2 /* prefix */ + 1 + statusWidth + 1 + lastWidth + 1 + clientWidth
		const availableForFlex = Math.max(2 * MIN_COL_WIDTH + 1, contentW - fixedNoFlex)
		const desiredFlex = sessionWidth + 1 + workspaceWidth
		let sessionW = sessionWidth
		let workspaceW = workspaceWidth
		if (desiredFlex > availableForFlex) {
			const remaining = availableForFlex - 1
			sessionW = Math.max(MIN_COL_WIDTH, Math.floor(remaining / 2))
			workspaceW = Math.max(MIN_COL_WIDTH, remaining - sessionW)
		}

		const headerCells = [
			pad(HEADERS.session, sessionW),
			pad(HEADERS.workspace, workspaceW),
			pad(HEADERS.status, statusWidth),
			pad(HEADERS.lastActivity, lastWidth),
			HEADERS.client,
		]
		const headerLine = headerCells.join(" ")

		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const formatPlain = (r: SessionRow): string => {
			const session = pad(truncate(sessionLabel(r), sessionW), sessionW)
			const workspace = pad(truncate(r.workspaceName || "-", workspaceW), workspaceW)
			const status = pad(STATUS_LABEL[r.status], statusWidth)
			const last = pad(lastLabel(r), lastWidth)
			const client = clientLabel(r)
			return [session, workspace, status, last, client].join(" ")
		}

		const formatStyled = (r: SessionRow): { styled: string; plainLen: number } => {
			const session = pad(truncate(sessionLabel(r), sessionW), sessionW)
			const workspace = pad(truncate(r.workspaceName || "-", workspaceW), workspaceW)
			const statusPlain = STATUS_LABEL[r.status]
			const statusPadding = " ".repeat(Math.max(0, statusWidth - statusPlain.length))
			const statusCell = `${statusLabel(r.status)}${statusPadding}`
			const last = pad(lastLabel(r), lastWidth)
			const client = clientLabel(r)
			const styled = [session, workspace, statusCell, last, client].join(" ")
			const plainCombined = [session, workspace, pad(statusPlain, statusWidth), last, client].join(" ")
			return { styled, plainLen: plainCombined.length }
		}

		const lines: string[] = []

		const titleText = " Sessions "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		lines.push(ansiRow(dim(`  ${headerLine}`), headerLine.length + 2))
		lines.push(b(`├${"─".repeat(innerW)}┤`))

		// Viewport height derived from MAX_HEIGHT_PCT so the panel always emits
		// exactly `viewportRows + 2 indicator rows` of body output regardless of
		// selection or rows count — this prevents the row-shift that would
		// otherwise jostle chat content underneath as the user navigates.
		const overlayMaxRows = Math.floor(this.tui.terminal.rows * MAX_HEIGHT_PCT)
		const viewportRows = Math.max(1, overlayMaxRows - CHROME_LINES)

		if (rows.length === 0) {
			lines.push(emptyRow())
			const text = "  (no sessions)"
			lines.push(ansiRow(dim(text), text.length))
			for (let i = 1; i < viewportRows; i++) lines.push(emptyRow())
			lines.push(emptyRow())
		} else {
			const { start, end } = computeVisibleWindow(this.selectedIndex, rows.length, viewportRows)

			if (start > 0) {
				const text = `  ↑ ${start} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}

			for (let i = start; i < end; i++) {
				const r = rows[i] as SessionRow
				if (i === this.selectedIndex) {
					const plain = formatPlain(r)
					const raw = `> ${plain}`
					lines.push(ansiRow(fg("36", raw), raw.length))
				} else {
					const { styled, plainLen } = formatStyled(r)
					lines.push(ansiRow(`  ${styled}`, plainLen + 2))
				}
			}
			for (let i = end - start; i < viewportRows; i++) lines.push(emptyRow())

			if (end < rows.length) {
				const text = `  ↓ ${rows.length - end} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}
		}

		lines.push(emptyRow())
		const hint = "↑/↓ j/k: navigate  enter: open  d: delete  esc: close"
		lines.push(ansiRow(dim(`  ${hint}`), hint.length + 2))
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
	}

	invalidate(): void {}
	dispose(): void {}
}

export function createSessionsPanel(
	rows: SessionRow[],
	tui: PickerTui,
	done: (result: SessionPickerResult | undefined) => void,
): SessionsPanel & { dispose(): void } {
	return new SessionsPanel(rows, tui, done)
}

export function pickSession(ctx: TeleportContext, rows: SessionRow[]): Promise<SessionPickerResult | undefined> {
	return ctx.ui.custom<SessionPickerResult | undefined>(
		(tui, _theme, _kb, done) => new SessionsPanel(rows, tui, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
	)
}
