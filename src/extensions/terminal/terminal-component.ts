import { CURSOR_MARKER, type TUI, type Component } from "@earendil-works/pi-tui"
import Terminal from "terminal.js"
import type { SshSession } from "./ssh-session.js"

export class TerminalComponent implements Component {
	terminal: Terminal
	prevWidth = 0
	prevRows = 0
	focused = false
	tui: TUI

	constructor(
		tui: TUI,
		private session: SshSession,
	) {
		this.tui = tui
		this.terminal = new Terminal({ columns: 80, rows: 24 })
	}

	render(width: number): string[] {
		const rows = this.tui.terminal.rows
		if (width !== this.prevWidth || rows !== this.prevRows) {
			this.terminal.state.resize({ columns: width, rows })
			this.session.resize(rows, width)
			this.prevWidth = width
			this.prevRows = rows
		}

		const lines: string[] = []
		const bufferRows = this.terminal.state.getBufferRowCount()
		for (let i = 0; i < rows; i++) {
			if (i < bufferRows) {
				const line = this.terminal.state.getLine(i)
				let text = line.str
				if (text.length > width) {
					text = text.slice(0, width)
				} else if (text.length < width) {
					text = text.padEnd(width)
				}
				lines.push(text)
			} else {
				lines.push(" ".repeat(width))
			}
		}

		// Cursor
		if (this.focused) {
			const cursor = this.terminal.state.cursor
			if (cursor.y >= 0 && cursor.y < lines.length) {
				const line = lines[cursor.y]
				lines[cursor.y] =
					line.slice(0, cursor.x) + CURSOR_MARKER + line.slice(cursor.x)
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
		this.session.close()
	}
}
