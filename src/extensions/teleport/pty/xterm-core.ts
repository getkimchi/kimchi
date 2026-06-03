import { copyToClipboard } from "@earendil-works/pi-coding-agent"
import { Terminal } from "@xterm/headless"

const DEFAULT_COLOR = 256

export interface CellData {
	char: number
	fg: number
	bg: number
	flags: number
	fgRgb?: number
	bgRgb?: number
}

export interface CursorState {
	row: number
	col: number
	visible: boolean
}

export class XtermCore {
	private terminal: Terminal
	private cursorVisible = true
	private _disposables: (() => void)[] = []

	constructor(cols = 80, rows = 24) {
		this.terminal = new Terminal({
			cols,
			rows,
			cursorBlink: false,
			allowProposedApi: true,
		})
		this._trackCursorVisibility()
		this._trackTmuxClipboardSync()
	}

	init(cols: number, rows: number): void {
		this.terminal.resize(cols, rows)
	}

	resize(cols: number, rows: number): void {
		this.terminal.resize(cols, rows)
	}

	writeString(str: string): Promise<void> {
		return new Promise((resolve) => this.terminal.write(str, resolve))
	}

	writeRaw(data: Uint8Array): Promise<void> {
		return new Promise((resolve) => this.terminal.write(data, resolve))
	}

	getCell(row: number, col: number): CellData {
		const buffer = this.terminal.buffer.active
		const line = buffer.getLine(buffer.viewportY + row)
		if (!line) {
			return { char: 32, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 0 }
		}
		const cell = line.getCell(col)
		if (!cell) {
			return { char: 32, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 0 }
		}

		const char = cell.getCode() || 32
		let fg = DEFAULT_COLOR
		let bg = DEFAULT_COLOR
		let fgRgb: number | undefined
		let bgRgb: number | undefined

		if (cell.isFgRGB()) {
			fgRgb = cell.getFgColor()
		} else if (cell.isFgPalette()) {
			fg = cell.getFgColor()
		}

		if (cell.isBgRGB()) {
			bgRgb = cell.getBgColor()
		} else if (cell.isBgPalette()) {
			bg = cell.getBgColor()
		}

		let flags = 0
		if (cell.isBold()) flags |= 0x01
		if (cell.isDim()) flags |= 0x02
		if (cell.isItalic()) flags |= 0x04
		if (cell.isUnderline()) flags |= 0x08
		if (cell.isBlink()) flags |= 0x10
		if (cell.isInverse()) flags |= 0x20
		if (cell.isStrikethrough()) flags |= 0x80

		return { char, fg, bg, flags, fgRgb, bgRgb }
	}

	getCursor(): CursorState {
		const buffer = this.terminal.buffer.active
		return {
			row: buffer.cursorY,
			col: buffer.cursorX,
			visible: this.cursorVisible,
		}
	}

	getCols(): number {
		return this.terminal.cols
	}

	getRows(): number {
		return this.terminal.rows
	}

	dispose(): void {
		for (const dispose of this._disposables) {
			dispose()
		}
		this.terminal.dispose()
	}

	private _trackCursorVisibility(): void {
		const showHandler = this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
			if (params.flat().includes(25)) this.cursorVisible = true
			return false
		})
		const hideHandler = this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
			if (params.flat().includes(25)) this.cursorVisible = false
			return false
		})
		this._disposables.push(() => showHandler.dispose())
		this._disposables.push(() => hideHandler.dispose())
	}

	private _trackTmuxClipboardSync(): void {
		const osc52Handler = this.terminal.parser.registerOscHandler(52, (data) => {
			// OSC 52 format: "<selection>;<base64>" where selection is 'c' (clipboard),
			// 'p' (primary), 's' (secondary), or 'q' (selection).
			const semicolonIndex = data.indexOf(";")
			if (semicolonIndex === -1) {
				return false
			}
			const b64 = data.slice(semicolonIndex + 1)
			if (!b64) {
				return false
			}
			try {
				const text = Buffer.from(b64, "base64").toString("utf-8")
				copyToClipboard(text).catch(() => {
					/* Silently ignore clipboard errors so tmux keeps working */
				})
				return true
			} catch {
				return false
			}
		})
		this._disposables.push(() => osc52Handler.dispose())
	}
}

export function createXtermCore(cols = 80, rows = 24): XtermCore {
	return new XtermCore(cols, rows)
}
