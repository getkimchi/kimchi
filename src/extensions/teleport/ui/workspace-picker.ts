import type { Component } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"

export type WorkspacePickerResult = { kind: "existing"; id: string } | { kind: "new" }

type Row = { kind: "existing"; workspace: Workspace } | { kind: "new" }

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

class WorkspacePickerPanel implements Component {
	private selectedIndex = 0
	private readonly rows: Row[]

	constructor(
		workspaces: Workspace[],
		private readonly tui: PickerTui,
		private readonly done: (result: WorkspacePickerResult | undefined) => void,
	) {
		this.rows = [...workspaces.map<Row>((w) => ({ kind: "existing", workspace: w })), { kind: "new" }]
	}

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
		if (matchesKey(data, "n")) {
			this.done({ kind: "new" })
			return
		}
		if (matchesKey(data, "return")) {
			const row = this.rows[this.selectedIndex] as Row
			if (row.kind === "new") {
				this.done({ kind: "new" })
			} else {
				this.done({ kind: "existing", id: row.workspace.id })
			}
			return
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined)
		}
	}

	render(width: number): string[] {
		const b = (s: string) => fg("2", s)
		const innerW = Math.max(20, width - 2)
		const contentW = innerW - 2

		const idWidth = Math.max(2, ...this.rows.map((r) => (r.kind === "existing" ? r.workspace.id.length : 0)))
		const longestName = Math.max(
			4,
			...this.rows.map((r) => (r.kind === "existing" ? (r.workspace.name || "-").length : 0)),
		)
		const statusWidth = Math.max(6, ...this.rows.map((r) => (r.kind === "existing" ? r.workspace.status.length : 0)))
		// "> " + id + " " + name + " " + status = fixed-ish
		const fixed = 2 + idWidth + 1 + 1 + statusWidth
		const nameWidth = Math.max(4, Math.min(longestName, contentW - fixed))

		const formatRow = (row: Row): string => {
			if (row.kind === "new") {
				return fg("36", "+ new workspace")
			}
			const w = row.workspace
			const id = pad(w.id.slice(0, idWidth), idWidth)
			const name = pad(truncate(w.name || "-", nameWidth), nameWidth)
			const status = pad(w.status, statusWidth)
			return [id, name, status].join(" ")
		}

		const rowLine = (content: string) => `${b("│")} ${pad(content, contentW)} ${b("│")}`
		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`

		const lines: string[] = []
		const titleText = " Workspaces "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		const maxVisibleRows = Math.max(1, this.tui.terminal.rows - 8)
		const { start, end } = computeVisibleWindow(this.selectedIndex, this.rows.length, maxVisibleRows)

		if (start > 0) {
			const text = `  ↑ ${start} more`
			lines.push(ansiRow(dim(text), text.length))
		}

		for (let i = start; i < end; i++) {
			const row = this.rows[i] as Row
			const content = formatRow(row)
			if (i === this.selectedIndex) {
				const rendered = `> ${content}`
				const rawLen = rawLength(rendered)
				lines.push(ansiRow(fg("36", rendered), rawLen))
			} else {
				lines.push(rowLine(`  ${stripAnsi(content)}`))
			}
		}

		if (end < this.rows.length) {
			const text = `  ↓ ${this.rows.length - end} more`
			lines.push(ansiRow(dim(text), text.length))
		}

		lines.push(emptyRow())
		const hint = "↑/↓ j/k: navigate  enter: select  n: new  esc: cancel"
		lines.push(ansiRow(dim(`  ${hint}`), hint.length + 2))
		lines.push(b(`╰${"─".repeat(innerW)}╯`))
		return lines
	}

	invalidate(): void {}
	dispose(): void {}
}

const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

function rawLength(s: string): number {
	return stripAnsi(s).length
}

export function pickWorkspace(
	ctx: TeleportContext,
	workspaces: Workspace[],
): Promise<WorkspacePickerResult | undefined> {
	return ctx.ui.custom<WorkspacePickerResult | undefined>(
		(tui, _theme, _kb, done) => new WorkspacePickerPanel(workspaces, tui, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "70%" } },
	)
}
