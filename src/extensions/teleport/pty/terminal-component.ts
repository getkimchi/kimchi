import { CURSOR_MARKER, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui"
import type { CellData, XtermCore } from "./xterm-core.js"

const DEFAULT_COLOR = 256

function sgrColor(base: number, code: number, rgb?: number): string {
	if (rgb !== undefined) {
		const r = (rgb >> 16) & 0xff
		const g = (rgb >> 8) & 0xff
		const b = rgb & 0xff
		return `${base + 8};2;${r};${g};${b}`
	}
	if (code === DEFAULT_COLOR) return String(base + 9)
	if (code < 8) return String(base + code)
	if (code < 16) return String(base + code + 82)
	return `${base + 8};5;${code}`
}

function cellStyle(cell: CellData): string {
	const parts: string[] = []
	if (cell.fgRgb !== undefined) {
		parts.push(sgrColor(30, DEFAULT_COLOR, cell.fgRgb))
	} else if (cell.fg !== DEFAULT_COLOR) {
		parts.push(sgrColor(30, cell.fg))
	}
	if (cell.bgRgb !== undefined) {
		parts.push(sgrColor(40, DEFAULT_COLOR, cell.bgRgb))
	} else if (cell.bg !== DEFAULT_COLOR) {
		parts.push(sgrColor(40, cell.bg))
	}
	if (cell.flags & 0x01) parts.push("1")
	if (cell.flags & 0x02) parts.push("2")
	if (cell.flags & 0x04) parts.push("3")
	if (cell.flags & 0x08) parts.push("4")
	if (cell.flags & 0x10) parts.push("5")
	if (cell.flags & 0x20) parts.push("7")
	if (cell.flags & 0x80) parts.push("9")
	return parts.length === 0 ? "" : `\x1b[${parts.join(";")}m`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces a CSI sequence we must parse
const KITTY_CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/
const KITTY_LOCK_MASK = 64 + 128

export function toRawAnsi(data: string): Buffer | undefined {
	// Legacy arrow sequences with optional kitty event suffix:
	// \x1b[1;<mod>:<event>A/B/C/D
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the legacy arrow CSI
	const mArrow = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/)
	if (mArrow) {
		const mod = Number.parseInt(mArrow[1], 10)
		const ev = mArrow[2] ? Number.parseInt(mArrow[2], 10) : 1
		if (ev === 3) return Buffer.alloc(0)
		const suffix = mArrow[3]
		return Buffer.from(mod === 1 ? `\x1b[${suffix}` : `\x1b[1;${mod}${suffix}`)
	}

	// Legacy functional key sequences with optional kitty event suffix:
	// \x1b[<num>;<mod>:<event>~
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the functional-key CSI
	const mFunc = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/)
	if (mFunc) {
		const num = Number.parseInt(mFunc[1], 10)
		const mod = mFunc[2] ? Number.parseInt(mFunc[2], 10) : 1
		const ev = mFunc[3] ? Number.parseInt(mFunc[3], 10) : 1
		if (ev === 3) return Buffer.alloc(0)
		return Buffer.from(mod === 1 ? `\x1b[${num}~` : `\x1b[${num};${mod}~`)
	}

	// Legacy home/end sequences with optional kitty event suffix:
	// \x1b[1;<mod>:<event>H/F
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the home/end CSI
	const mHomeEnd = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/)
	if (mHomeEnd) {
		const mod = Number.parseInt(mHomeEnd[1], 10)
		const ev = mHomeEnd[2] ? Number.parseInt(mHomeEnd[2], 10) : 1
		if (ev === 3) return Buffer.alloc(0)
		const suffix = mHomeEnd[3]
		return Buffer.from(mod === 1 ? `\x1b[${suffix}` : `\x1b[1;${mod}${suffix}`)
	}

	const m = data.match(KITTY_CSI_U_RE)
	if (!m) return undefined

	const cp = Number.parseInt(m[1], 10)
	const mod = ((m[4] ? Number.parseInt(m[4], 10) : 1) - 1) & ~KITTY_LOCK_MASK
	const ev = m[5] ? Number.parseInt(m[5], 10) : 1

	if (ev === 3) return Buffer.alloc(0)

	const shift = (mod & 1) !== 0
	const alt = (mod & 2) !== 0
	const ctrl = (mod & 4) !== 0
	const superMod = (mod & 8) !== 0
	if (superMod) return undefined

	if (cp >= 57417 && cp <= 57420) {
		const arrow: Record<number, string> = {
			57419: "A",
			57420: "B",
			57418: "C",
			57417: "D",
		}
		const suffix = arrow[cp]
		if (suffix) return Buffer.from(mod ? `\x1b[1;${mod + 1}${suffix}` : `\x1b[${suffix}`)
	}
	if (cp === 57423 || cp === 57424) {
		const suffix = cp === 57423 ? "H" : "F"
		return Buffer.from(mod ? `\x1b[1;${mod + 1}${suffix}` : `\x1b[${suffix}`)
	}
	if (cp >= 57421 && cp <= 57426) {
		const num: Record<number, number> = {
			57421: 5,
			57422: 6,
			57425: 2,
			57426: 3,
		}
		const n = num[cp]
		if (n) return Buffer.from(mod ? `\x1b[${n};${mod + 1}~` : `\x1b[${n}~`)
	}
	if (cp >= 57399 && cp <= 57416) {
		const mapped: Record<number, number> = {
			57399: 48,
			57400: 49,
			57401: 50,
			57402: 51,
			57403: 52,
			57404: 53,
			57405: 54,
			57406: 55,
			57407: 56,
			57408: 57,
			57409: 46,
			57410: 47,
			57411: 42,
			57412: 45,
			57413: 43,
			57415: 61,
			57416: 44,
		}
		const n = mapped[cp]
		if (n) return encodePrintable(n, mod)
	}

	if (cp === 0) return alt ? Buffer.from("\x1b\x00") : Buffer.from("\x00")
	if (cp === 9) return shift ? Buffer.from("\x1b[Z") : alt ? Buffer.from("\x1b\t") : Buffer.from("\t")
	if (cp === 13 || cp === 57414) return alt ? Buffer.from("\x1b\r") : shift ? Buffer.from("\n") : Buffer.from("\r")
	if (cp === 27) return alt || ctrl ? Buffer.from("\x1b\x1b") : Buffer.from("\x1b")
	if (cp === 32) return ctrl ? Buffer.from("\x00") : alt ? Buffer.from("\x1b ") : Buffer.from(" ")
	if (cp === 127) return alt ? Buffer.from("\x1b\x7f") : ctrl ? Buffer.from("\x08") : Buffer.from("\x7f")

	if (cp >= 1 && cp <= 31) {
		const ch = String.fromCharCode(cp)
		return alt ? Buffer.from(`\x1b${ch}`) : Buffer.from(ch)
	}

	if (cp >= 32 && cp <= 126) return encodePrintable(cp, mod)

	return undefined
}

function encodePrintable(cp: number, mod: number): Buffer {
	let ch = String.fromCharCode(cp)
	if (mod & 1 && cp >= 97 && cp <= 122) ch = ch.toUpperCase()

	const ctrl = (mod & 4) !== 0
	const alt = (mod & 2) !== 0

	if (ctrl && alt) {
		const cc = toCtrlChar(ch)
		return Buffer.from(cc ? `\x1b${cc}` : `\x1b${ch}`)
	}
	if (ctrl) {
		const cc = toCtrlChar(ch)
		return Buffer.from(cc ?? ch)
	}
	if (alt) return Buffer.from(`\x1b${ch}`)
	return Buffer.from(ch)
}

function toCtrlChar(key: string): string | null {
	const c = key.toLowerCase()
	const code = c.charCodeAt(0)
	if ((code >= 97 && code <= 122) || c === "[" || c === "\\" || c === "]" || c === "_" || c === "^") {
		return String.fromCharCode(code & 0x1f)
	}
	if (c === "-" || c === " ") return "\x1f"
	if (c === "@" || c === "`") return "\x00"
	return null
}

interface MouseScroll {
	direction: "up" | "down"
	x: number
	y: number
}

function parseMouseScroll(data: string): MouseScroll | undefined {
	// SGR scroll: ESC [ < 64 ; x ; y M   (scroll up)
	// SGR scroll: ESC [ < 65 ; x ; y M   (scroll down)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the SGR mouse-scroll CSI
	const sgrMatch = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
	if (sgrMatch) {
		const button = Number.parseInt(sgrMatch[1], 10)
		if (button === 64) {
			return { direction: "up", x: Number.parseInt(sgrMatch[2], 10), y: Number.parseInt(sgrMatch[3], 10) }
		}
		if (button === 65) {
			return { direction: "down", x: Number.parseInt(sgrMatch[2], 10), y: Number.parseInt(sgrMatch[3], 10) }
		}
	}

	// X10 scroll: ESC [ M <buttonByte> <xByte> <yByte>
	// buttonByte = 64 + 32 = 96 (\x60) for scroll up
	// buttonByte = 65 + 32 = 97 (\x61) for scroll down
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const buttonByte = data.charCodeAt(3)
		const xByte = data.charCodeAt(4)
		const yByte = data.charCodeAt(5)
		const button = buttonByte - 32
		if (button === 64) {
			return { direction: "up", x: xByte - 32, y: yByte - 32 }
		}
		if (button === 65) {
			return { direction: "down", x: xByte - 32, y: yByte - 32 }
		}
	}

	return undefined
}

export interface TerminalSink {
	resize(rows: number, cols: number): void
	write(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
	close(): void
}

export class TerminalComponent implements Component {
	terminal: XtermCore
	prevWidth = 0
	prevRows = 0
	focused = false
	tui: TUI
	private heightOverride?: number

	constructor(
		tui: TUI,
		private session: TerminalSink,
		terminal: XtermCore,
	) {
		this.tui = tui
		this.terminal = terminal
	}

	setHeight(rows: number | undefined): void {
		this.heightOverride = rows
	}

	async writeRemoteData(data: string): Promise<void> {
		await this.terminal.writeString(data)
	}

	render(width: number): string[] {
		let rows = this.heightOverride ?? this.tui.terminal.rows
		if (rows <= 0 || Number.isNaN(rows)) rows = 24
		let cols = width
		if (cols <= 0 || Number.isNaN(cols)) cols = 80

		if (cols !== this.prevWidth || rows !== this.prevRows) {
			this.terminal.resize(cols, rows)
			this.session.resize(rows, cols)
			this.prevWidth = cols
			this.prevRows = rows
		}

		const lines: string[] = []
		const cursor = this.terminal.getCursor()
		const cursorRow = this.focused && cursor.visible ? cursor.row : -1
		const cursorCol = this.focused && cursor.visible ? cursor.col : -1
		for (let i = 0; i < rows; i++) {
			lines.push(this.getLine(i, cols, cursorRow === i ? cursorCol : undefined))
		}

		return lines
	}

	private getLine(row: number, width: number, cursorCol?: number): string {
		let text = ""
		let prevStyle = ""
		for (let col = 0; col < width; col++) {
			const cell = this.terminal.getCell(row, col)
			const style = cellStyle(cell)
			if (style !== prevStyle) {
				text += `\x1b[0m${style}`
				prevStyle = style
			}
			if (cursorCol === col) {
				text += CURSOR_MARKER
			}
			text += String.fromCodePoint(cell.char)
		}
		if (cursorCol === width) {
			text += CURSOR_MARKER
		}
		if (prevStyle !== "") {
			text += "\x1b[0m"
		}
		const trimmed = text.trimEnd()
		const padCount = width - visibleWidth(trimmed)
		return trimmed + " ".repeat(Math.max(0, padCount))
	}

	setFocus(focused: boolean): void {
		this.focused = focused
	}

	handleInput(data: string): void {
		const raw = toRawAnsi(data)
		this.session.write(raw !== undefined ? raw : Buffer.from(data, "utf-8"))
	}

	wantsKeyRelease = true

	invalidate(): void {
		// handled by tui.requestRender
	}

	dispose(): void {
		this.session.close()
	}
}
