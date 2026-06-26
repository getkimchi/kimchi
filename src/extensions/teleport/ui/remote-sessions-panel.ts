import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { TeleportContext } from "../types.js"
import type { CombinedStatus, SessionRow } from "./sessions-table.js"
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

/** A session nested under a workspace. Structurally identical to SessionRow. */
export type RemoteSessionNode = SessionRow

export interface RemoteWorkspaceNode {
	row: WorkspaceRow
	/** Visible sessions, already sorted by lastActivityAt desc. */
	sessions: RemoteSessionNode[]
	/** True when the worker could not be reached (auth/listSessions failed). */
	unreachable: boolean
}

export type RemoteSessionsResult =
	| { action: "open-terminal"; node: RemoteWorkspaceNode }
	| { action: "delete-workspace"; node: RemoteWorkspaceNode }
	| { action: "rename-workspace"; node: RemoteWorkspaceNode }
	| { action: "open-session"; node: RemoteSessionNode }
	| { action: "delete-session"; node: RemoteSessionNode }

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
	name: "NAME / SESSION",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
}

const MIN_COL_WIDTH = 8

type Entry =
	| { kind: "workspace"; node: RemoteWorkspaceNode }
	| { kind: "session"; node: RemoteSessionNode; isLast: boolean }

function entryStatus(entry: Entry): CombinedStatus {
	if (entry.kind === "session") return entry.node.status
	// WorkspaceStatus ("active" | "idle" | "completed") is a subset of CombinedStatus.
	return entry.node.unreachable ? "unreachable" : entry.node.row.status
}

function entryLastActivity(entry: Entry): Date | undefined {
	return entry.kind === "session" ? entry.node.lastActivityAt : entry.node.row.lastActivityAt
}

function entryNameText(entry: Entry): string {
	if (entry.kind === "workspace") return entry.node.row.name || "-"
	const connector = entry.isLast ? "└─ " : "├─ "
	return `${connector}${entry.node.sessionName || "-"}`
}

export class RemoteSessionsPanel implements Component {
	private selectedIndex = 0
	private readonly now = new Date()
	private readonly entries: Entry[]

	constructor(
		private readonly nodes: RemoteWorkspaceNode[],
		private readonly tui: PickerTui,
		private readonly done: (result: RemoteSessionsResult | undefined) => void,
	) {
		const entries: Entry[] = []
		for (const node of nodes) {
			entries.push({ kind: "workspace", node })
			node.sessions.forEach((session, i) => {
				entries.push({ kind: "session", node: session, isLast: i === node.sessions.length - 1 })
			})
		}
		this.entries = entries
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
		if (matchesKey(data, "return")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry) return
			if (entry.kind === "workspace") {
				this.done({ action: "open-terminal", node: entry.node })
			} else {
				if (entry.node.sessionName === "") return
				this.done({ action: "open-session", node: entry.node })
			}
			return
		}
		if (matchesKey(data, "d")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry) return
			if (entry.kind === "workspace") {
				this.done({ action: "delete-workspace", node: entry.node })
			} else {
				if (entry.node.sessionName === "") return
				this.done({ action: "delete-session", node: entry.node })
			}
			return
		}
		if (matchesKey(data, "r")) {
			const entry = this.entries[this.selectedIndex]
			if (!entry || entry.kind !== "workspace") return
			this.done({ action: "rename-workspace", node: entry.node })
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "x")) {
			this.done(undefined)
		}
	}

	render(width: number): string[] {
		const { entries } = this
		const b = (s: string) => fg("2", s)
		const innerW = Math.max(20, width - 2)
		const contentW = innerW - 2

		const lastLabel = (entry: Entry) => {
			const d = entryLastActivity(entry)
			return d ? formatRelativeTime(d, this.now) : "-"
		}

		const statusWidth = Math.max(HEADERS.status.length, ...entries.map((e) => STATUS_LABEL[entryStatus(e)].length))
		const lastWidth = Math.max(HEADERS.lastActivity.length, ...entries.map((e) => lastLabel(e).length))

		// Name is the only flex column; it absorbs the tree-connector indent.
		const fixedNoFlex = 2 /* prefix */ + 1 + statusWidth + 1 + lastWidth
		const nameW = Math.max(MIN_COL_WIDTH, contentW - fixedNoFlex)

		const headerCells = [pad(HEADERS.name, nameW), pad(HEADERS.status, statusWidth), HEADERS.lastActivity]
		const headerLine = headerCells.join(" ")

		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const formatPlain = (entry: Entry): string => {
			const name = pad(truncate(entryNameText(entry), nameW), nameW)
			const status = pad(STATUS_LABEL[entryStatus(entry)], statusWidth)
			const last = lastLabel(entry)
			return [name, status, last].join(" ")
		}

		const formatStyled = (entry: Entry): { styled: string; plainLen: number } => {
			const name = pad(truncate(entryNameText(entry), nameW), nameW)
			const statusPlain = STATUS_LABEL[entryStatus(entry)]
			const statusPadding = " ".repeat(Math.max(0, statusWidth - statusPlain.length))
			const statusCell = `${statusLabel(entryStatus(entry))}${statusPadding}`
			const last = lastLabel(entry)
			const styled = [name, statusCell, last].join(" ")
			const plainCombined = [name, pad(statusPlain, statusWidth), last].join(" ")
			return { styled, plainLen: plainCombined.length }
		}

		const lines: string[] = []

		const titleText = " Remote Sessions "
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

		if (entries.length === 0) {
			lines.push(emptyRow())
			const text = "  (no workspaces)"
			lines.push(ansiRow(dim(text), text.length))
			for (let i = 1; i < viewportRows; i++) lines.push(emptyRow())
			lines.push(emptyRow())
		} else {
			const { start, end } = computeVisibleWindow(this.selectedIndex, entries.length, viewportRows)

			if (start > 0) {
				const text = `  ↑ ${start} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}

			for (let i = start; i < end; i++) {
				const entry = entries[i] as Entry
				if (i === this.selectedIndex) {
					const plain = formatPlain(entry)
					const raw = `> ${plain}`
					lines.push(ansiRow(fg("36", raw), raw.length))
				} else {
					const { styled, plainLen } = formatStyled(entry)
					lines.push(ansiRow(`  ${styled}`, plainLen + 2))
				}
			}
			for (let i = end - start; i < viewportRows; i++) lines.push(emptyRow())

			if (end < entries.length) {
				const text = `  ↓ ${entries.length - end} more`
				lines.push(ansiRow(dim(text), text.length))
			} else {
				lines.push(emptyRow())
			}
		}

		lines.push(emptyRow())
		const hint = "↑/↓ j/k: navigate  enter: open  d: delete  r: rename  esc: close"
		lines.push(ansiRow(dim(`  ${hint}`), hint.length + 2))
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
	}

	invalidate(): void {}
	dispose(): void {}
}

export function createRemoteSessionsPanel(
	nodes: RemoteWorkspaceNode[],
	tui: PickerTui,
	done: (result: RemoteSessionsResult | undefined) => void,
): RemoteSessionsPanel & { dispose(): void } {
	return new RemoteSessionsPanel(nodes, tui, done)
}

export function pickRemoteSessions(
	ctx: TeleportContext,
	nodes: RemoteWorkspaceNode[],
): Promise<RemoteSessionsResult | undefined> {
	return ctx.ui.custom<RemoteSessionsResult | undefined>(
		(tui, _theme, _kb, done) => new RemoteSessionsPanel(nodes, tui, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
	)
}
