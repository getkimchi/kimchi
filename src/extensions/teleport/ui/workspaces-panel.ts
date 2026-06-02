import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { WorkspaceStatus } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"
import { FULL_SCREEN_OVERLAY_OPTIONS, FullScreenOverlay } from "./full-screen-overlay.js"
import { formatRelativeTime } from "./sessions-table.js"
import type { WorkspaceRow } from "./workspaces-table.js"

export type WorkspacePickerAction = "terminal" | "delete"

export interface WorkspacePickerResult {
	action: WorkspacePickerAction
	row: WorkspaceRow
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

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
	active: "active",
	idle: "idle",
	completed: "completed",
}

function statusLabel(s: WorkspaceStatus): string {
	const text = STATUS_LABEL[s]
	switch (s) {
		case "active":
			return fg("36", text)
		case "idle":
		case "completed":
			return dim(text)
	}
}

const HEADERS = {
	name: "NAME",
	id: "ID",
	status: "STATUS",
	created: "CREATED",
	lastActivity: "LAST ACTIVITY",
	sessions: "SESSIONS",
	host: "HOST",
}

const ID_SHORT_LEN = 8
const MIN_COL_WIDTH = 8

function shortId(id: string): string {
	return id.length > ID_SHORT_LEN ? id.slice(0, ID_SHORT_LEN) : id
}

export class WorkspacesPanel implements Component {
	private selectedIndex = 0
	private readonly now = new Date()

	constructor(
		private readonly rows: WorkspaceRow[],
		private readonly tui: PickerTui,
		private readonly done: (result: WorkspacePickerResult | undefined) => void,
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
			if (!row) return
			this.done({ action: "terminal", row })
			return
		}
		if (matchesKey(data, "d")) {
			const row = this.rows[this.selectedIndex]
			if (!row) return
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

		const nameLabel = (r: WorkspaceRow) => r.name || "-"
		const idLabel = (r: WorkspaceRow) => shortId(r.id)
		const createdLabel = (r: WorkspaceRow) => (r.createdAt ? formatRelativeTime(r.createdAt, this.now) : "-")
		const lastLabel = (r: WorkspaceRow) => (r.lastActivityAt ? formatRelativeTime(r.lastActivityAt, this.now) : "-")
		const sessionsLabel = (r: WorkspaceRow) => (r.sessionCount === "?" ? "?" : String(r.sessionCount))
		const hostLabel = (r: WorkspaceRow) => r.host || "-"

		const idWidth = Math.max(HEADERS.id.length, ID_SHORT_LEN)
		const statusWidth = Math.max(HEADERS.status.length, ...rows.map((r) => STATUS_LABEL[r.status].length))
		const createdWidth = Math.max(HEADERS.created.length, ...rows.map((r) => createdLabel(r).length))
		const lastWidth = Math.max(HEADERS.lastActivity.length, ...rows.map((r) => lastLabel(r).length))
		const sessionsWidth = Math.max(HEADERS.sessions.length, ...rows.map((r) => sessionsLabel(r).length))

		const nameWidth = Math.max(HEADERS.name.length, ...rows.map((r) => nameLabel(r).length))
		const hostWidth = Math.max(HEADERS.host.length, ...rows.map((r) => hostLabel(r).length))

		// Fixed-width slice excludes the two flex columns (name, host).
		const fixedNoFlex =
			2 /* prefix */ + idWidth + 1 + statusWidth + 1 + createdWidth + 1 + lastWidth + 1 + sessionsWidth
		const availableForFlex = Math.max(2 * MIN_COL_WIDTH + 1, contentW - fixedNoFlex)
		const desiredFlex = nameWidth + 1 + hostWidth
		let nameW = nameWidth
		let hostW = hostWidth
		if (desiredFlex > availableForFlex) {
			const remaining = availableForFlex - 1
			nameW = Math.max(MIN_COL_WIDTH, Math.floor(remaining / 2))
			hostW = Math.max(MIN_COL_WIDTH, remaining - nameW)
		}

		const headerCells = [
			pad(HEADERS.name, nameW),
			pad(HEADERS.id, idWidth),
			pad(HEADERS.status, statusWidth),
			pad(HEADERS.created, createdWidth),
			pad(HEADERS.lastActivity, lastWidth),
			pad(HEADERS.sessions, sessionsWidth),
			HEADERS.host,
		]
		const headerLine = headerCells.join(" ")

		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const formatPlain = (r: WorkspaceRow): string => {
			const name = pad(truncate(nameLabel(r), nameW), nameW)
			const id = pad(idLabel(r), idWidth)
			const status = pad(STATUS_LABEL[r.status], statusWidth)
			const created = pad(createdLabel(r), createdWidth)
			const last = pad(lastLabel(r), lastWidth)
			const sessions = pad(sessionsLabel(r), sessionsWidth)
			const host = truncate(hostLabel(r), hostW)
			return [name, id, status, created, last, sessions, host].join(" ")
		}

		const formatStyled = (r: WorkspaceRow): { styled: string; plainLen: number } => {
			const name = pad(truncate(nameLabel(r), nameW), nameW)
			const id = pad(idLabel(r), idWidth)
			const statusPlain = STATUS_LABEL[r.status]
			const statusPadding = " ".repeat(Math.max(0, statusWidth - statusPlain.length))
			const statusCell = `${statusLabel(r.status)}${statusPadding}`
			const created = pad(createdLabel(r), createdWidth)
			const last = pad(lastLabel(r), lastWidth)
			const sessions = pad(sessionsLabel(r), sessionsWidth)
			const host = truncate(hostLabel(r), hostW)
			const styled = [name, id, statusCell, created, last, sessions, host].join(" ")
			const plainCombined = [name, id, pad(statusPlain, statusWidth), created, last, sessions, host].join(" ")
			return { styled, plainLen: plainCombined.length }
		}

		const lines: string[] = []

		const titleText = " Workspaces "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		lines.push(ansiRow(dim(`  ${headerLine}`), headerLine.length + 2))
		lines.push(b(`├${"─".repeat(innerW)}┤`))

		// Reserve: top border(1) + header(1) + divider(1) + bottom border(1) + hint(1) + empty(1) = 6
		const maxVisibleRows = Math.max(1, this.tui.terminal.rows - 8)

		if (rows.length === 0) {
			const text = "  (no workspaces)"
			lines.push(ansiRow(dim(text), text.length))
		} else {
			const { start, end } = computeVisibleWindow(this.selectedIndex, rows.length, maxVisibleRows)

			if (start > 0) {
				const text = `  ↑ ${start} more`
				lines.push(ansiRow(dim(text), text.length))
			}

			for (let i = start; i < end; i++) {
				const r = rows[i] as WorkspaceRow
				if (i === this.selectedIndex) {
					const plain = formatPlain(r)
					const raw = `> ${plain}`
					lines.push(ansiRow(fg("36", raw), raw.length))
				} else {
					const { styled, plainLen } = formatStyled(r)
					lines.push(ansiRow(`  ${styled}`, plainLen + 2))
				}
			}

			if (end < rows.length) {
				const text = `  ↓ ${rows.length - end} more`
				lines.push(ansiRow(dim(text), text.length))
			}
		}

		lines.push(emptyRow())
		const hint = "↑/↓ j/k: navigate  enter: terminal  d: delete  esc: close"
		lines.push(ansiRow(dim(`  ${hint}`), hint.length + 2))
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
	}

	invalidate(): void {}
	dispose(): void {}
}

export function createWorkspacesPanel(
	rows: WorkspaceRow[],
	tui: PickerTui,
	done: (result: WorkspacePickerResult | undefined) => void,
): WorkspacesPanel & { dispose(): void } {
	return new WorkspacesPanel(rows, tui, done)
}

export function pickWorkspace(ctx: TeleportContext, rows: WorkspaceRow[]): Promise<WorkspacePickerResult | undefined> {
	return ctx.ui.custom<WorkspacePickerResult | undefined>(
		(tui, _theme, _kb, done) => new FullScreenOverlay(new WorkspacesPanel(rows, tui, done), tui),
		FULL_SCREEN_OVERLAY_OPTIONS,
	)
}
