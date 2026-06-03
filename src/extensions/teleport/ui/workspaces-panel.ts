import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { WorkspaceStatus } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"
import { formatRelativeTime } from "./sessions-table.js"
import type { WorkspaceRow } from "./workspaces-table.js"

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

export type WorkspacePickerResult =
	| { action: "select"; row: WorkspaceRow }
	| { action: "delete"; row: WorkspaceRow }
	| { action: "rename"; row: WorkspaceRow }
	| { action: "new" }

export interface WorkspacesPanelOptions {
	/** Append a synthetic "+ new workspace" row and bind `n` to it. */
	allowNew?: boolean
	/** Bind `d` to delete and show it in the hint footer. */
	allowDelete?: boolean
	/** Bind `r` to rename and show it in the hint footer. */
	allowRename?: boolean
	/** Drop the SESSIONS column entirely (used when session counts aren't fetched). */
	hideSessions?: boolean
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

type Entry = { kind: "row"; row: WorkspaceRow } | { kind: "new" }

export class WorkspacesPanel implements Component {
	private selectedIndex = 0
	private readonly now = new Date()
	private readonly entries: Entry[]
	private readonly allowNew: boolean
	private readonly allowDelete: boolean
	private readonly allowRename: boolean
	private readonly hideSessions: boolean

	constructor(
		private readonly rows: WorkspaceRow[],
		private readonly tui: PickerTui,
		private readonly done: (result: WorkspacePickerResult | undefined) => void,
		opts: WorkspacesPanelOptions = {},
	) {
		this.allowNew = opts.allowNew ?? false
		this.allowDelete = opts.allowDelete ?? false
		this.allowRename = opts.allowRename ?? false
		this.hideSessions = opts.hideSessions ?? false
		const rowEntries: Entry[] = rows.map((row) => ({ kind: "row", row }))
		this.entries = this.allowNew ? [...rowEntries, { kind: "new" }] : rowEntries
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1)
			this.tui.requestRender()
			return
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1)
			this.tui.requestRender()
			return
		}
		if (this.allowNew && matchesKey(data, "n")) {
			this.done({ action: "new" })
			return
		}
		if (matchesKey(data, "return")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry) return
			if (entry.kind === "new") {
				this.done({ action: "new" })
			} else {
				this.done({ action: "select", row: entry.row })
			}
			return
		}
		if (this.allowDelete && matchesKey(data, "d")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry || entry.kind !== "row") return
			this.done({ action: "delete", row: entry.row })
			return
		}
		if (this.allowRename && matchesKey(data, "r")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry || entry.kind !== "row") return
			this.done({ action: "rename", row: entry.row })
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "x")) {
			this.done(undefined)
		}
	}

	render(width: number): string[] {
		const { rows, hideSessions } = this
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
		const sessionsWidth = hideSessions
			? 0
			: Math.max(HEADERS.sessions.length, ...rows.map((r) => sessionsLabel(r).length))

		const nameWidth = Math.max(HEADERS.name.length, ...rows.map((r) => nameLabel(r).length))
		const hostWidth = Math.max(HEADERS.host.length, ...rows.map((r) => hostLabel(r).length))

		// Fixed-width slice excludes the two flex columns (name, host).
		const fixedNoFlex =
			2 /* prefix */ +
			idWidth +
			1 +
			statusWidth +
			1 +
			createdWidth +
			1 +
			lastWidth +
			(hideSessions ? 0 : 1 + sessionsWidth)
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
			...(hideSessions ? [] : [pad(HEADERS.sessions, sessionsWidth)]),
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
			const host = truncate(hostLabel(r), hostW)
			const cells = [name, id, status, created, last]
			if (!hideSessions) cells.push(pad(sessionsLabel(r), sessionsWidth))
			cells.push(host)
			return cells.join(" ")
		}

		const formatStyled = (r: WorkspaceRow): { styled: string; plainLen: number } => {
			const name = pad(truncate(nameLabel(r), nameW), nameW)
			const id = pad(idLabel(r), idWidth)
			const statusPlain = STATUS_LABEL[r.status]
			const statusPadding = " ".repeat(Math.max(0, statusWidth - statusPlain.length))
			const statusCell = `${statusLabel(r.status)}${statusPadding}`
			const created = pad(createdLabel(r), createdWidth)
			const last = pad(lastLabel(r), lastWidth)
			const host = truncate(hostLabel(r), hostW)
			const styledCells = [name, id, statusCell, created, last]
			const plainCells = [name, id, pad(statusPlain, statusWidth), created, last]
			if (!hideSessions) {
				const sessionsPad = pad(sessionsLabel(r), sessionsWidth)
				styledCells.push(sessionsPad)
				plainCells.push(sessionsPad)
			}
			styledCells.push(host)
			plainCells.push(host)
			return { styled: styledCells.join(" "), plainLen: plainCells.join(" ").length }
		}

		const lines: string[] = []

		const titleText = " Workspaces "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		lines.push(ansiRow(dim(`  ${headerLine}`), headerLine.length + 2))
		lines.push(b(`├${"─".repeat(innerW)}┤`))

		// Viewport height derived from MAX_HEIGHT_PCT so the panel always emits
		// exactly `viewportRows + 2 indicator rows` of body output regardless of
		// selection or entries count — this prevents the row-shift that would
		// otherwise jostle chat content underneath as the user navigates.
		const overlayMaxRows = Math.floor(this.tui.terminal.rows * MAX_HEIGHT_PCT)
		const viewportRows = Math.max(1, overlayMaxRows - CHROME_LINES)

		if (this.entries.length === 0) {
			lines.push(emptyRow())
			const text = "  (no workspaces)"
			lines.push(ansiRow(dim(text), text.length))
			for (let i = 1; i < viewportRows; i++) lines.push(emptyRow())
			lines.push(emptyRow())
		} else {
			const { start, end } = computeVisibleWindow(this.selectedIndex, this.entries.length, viewportRows)

			if (start > 0) {
				const text = `  ↑ ${start} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}

			for (let i = start; i < end; i++) {
				const entry = this.entries[i] as Entry
				const isSelected = i === this.selectedIndex
				if (entry.kind === "new") {
					const label = "+ new workspace"
					if (isSelected) {
						const raw = `> ${label}`
						lines.push(ansiRow(fg("36", raw), raw.length))
					} else {
						const text = `  ${fg("36", label)}`
						lines.push(ansiRow(text, label.length + 2))
					}
					continue
				}
				if (isSelected) {
					const plain = formatPlain(entry.row)
					const raw = `> ${plain}`
					lines.push(ansiRow(fg("36", raw), raw.length))
				} else {
					const { styled, plainLen } = formatStyled(entry.row)
					lines.push(ansiRow(`  ${styled}`, plainLen + 2))
				}
			}
			for (let i = end - start; i < viewportRows; i++) lines.push(emptyRow())

			if (end < this.entries.length) {
				const text = `  ↓ ${this.entries.length - end} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}
		}

		lines.push(emptyRow())
		const hintParts = ["↑/↓ j/k: navigate", "enter: select"]
		if (this.allowNew) hintParts.push("n: new")
		if (this.allowRename) hintParts.push("r: rename")
		if (this.allowDelete) hintParts.push("d: delete")
		hintParts.push("esc: cancel")
		const hint = hintParts.join("  ")
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
	opts?: WorkspacesPanelOptions,
): WorkspacesPanel & { dispose(): void } {
	return new WorkspacesPanel(rows, tui, done, opts)
}

export function pickWorkspace(
	ctx: TeleportContext,
	rows: WorkspaceRow[],
	opts?: WorkspacesPanelOptions,
): Promise<WorkspacePickerResult | undefined> {
	return ctx.ui.custom<WorkspacePickerResult | undefined>(
		(tui, _theme, _kb, done) => new WorkspacesPanel(rows, tui, done, opts),
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
	)
}
