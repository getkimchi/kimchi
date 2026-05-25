import { CURSOR_MARKER, type TUI, type Component } from "@earendil-works/pi-tui"
import { createTerminal, type GhosttyVtTerminal } from "@coder/libghostty-vt-node"
import type { SshSession } from "./ssh-session.js"

export class TerminalComponent implements Component {
	terminal: GhosttyVtTerminal
	prevWidth = 0
	prevRows = 0
	focused = false
	tui: TUI

	constructor(
		tui: TUI,
		private session: SshSession,
	) {
		this.tui = tui
		this.terminal = createTerminal({ cols: 80, rows: 24 })
	}

	render(width: number): string[] {
		const rows = this.tui.terminal.rows
		if (width !== this.prevWidth || rows !== this.prevRows) {
			this.terminal.resize(width, rows)
			this.session.resize(rows, width)
			this.prevWidth = width
			this.prevRows = rows
		}

		const snapshot = this.terminal.snapshot()
		const lines: string[] = []

		for (const vl of snapshot.visibleLines) {
			let line = vl.text
			if (line.length > width) {
				line = line.slice(0, width)
			} else if (line.length < width) {
				line = line.padEnd(width)
			}
			lines.push(line)
		}

		// Pad to terminal height with empty lines so overlay doesn't collapse
		while (lines.length < rows) {
			lines.push(" ".repeat(width))
		}

		// Cursor
		if (this.focused) {
			const cursorRow = snapshot.cursorRow
			const cursorCol = snapshot.cursorCol
			if (cursorRow >= 0 && cursorRow < lines.length) {
				const line = lines[cursorRow] ?? ""
				lines[cursorRow] =
					line.slice(0, cursorCol) + CURSOR_MARKER + line.slice(cursorCol)
			}
		}

		return lines
	}

	setFocus(focused: boolean): void {
		this.focused = focused
	}

	handleInput(data: string): void {
		this.session.write(Buffer.from(data, "utf-8"))
	}

	wantsKeyRelease = false

	invalidate(): void {
		// handled by tui.requestRender
	}

	dispose(): void {
		this.terminal.dispose()
		this.session.close()
	}
}
