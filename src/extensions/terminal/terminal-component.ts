import { CURSOR_MARKER, type TUI, type Component } from "@earendil-works/pi-tui"
import Terminal from "terminal.js"
import type { SshSession } from "./ssh-session.js"

const KITTY_CSI_U_RE = new RegExp(
  `^\\x1b\\[(\\d+)(?::(\\d*))?(?::(\\d+))?(?:;(\\d+))?(?::(\\d+))?u$`,
)
const KITTY_LOCK_MASK = 64 + 128

function toRawAnsi(data: string): Buffer | undefined {
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
    const arrow: Record<number, string> = { 57419: "A", 57420: "B", 57418: "C", 57417: "D" }
    const suffix = arrow[cp]
    if (suffix) return Buffer.from(mod ? `\x1b[1;${mod + 1}${suffix}` : `\x1b[${suffix}`)
  }
  if (cp === 57423 || cp === 57424) {
    const suffix = cp === 57423 ? "H" : "F"
    return Buffer.from(mod ? `\x1b[1;${mod + 1}${suffix}` : `\x1b[${suffix}`)
  }
  if (cp >= 57421 && cp <= 57426) {
    const num: Record<number, number> = { 57421: 5, 57422: 6, 57425: 2, 57426: 3 }
    const n = num[cp]
    if (n) return Buffer.from(mod ? `\x1b[${n};${mod + 1}~` : `\x1b[${n}~`)
  }
  if (cp >= 57399 && cp <= 57416) {
    const mapped: Record<number, number> = {
      57399: 48, 57400: 49, 57401: 50, 57402: 51, 57403: 52, 57404: 53,
      57405: 54, 57406: 55, 57407: 56, 57408: 57, 57409: 46, 57410: 47,
      57411: 42, 57412: 45, 57413: 43, 57415: 61, 57416: 44,
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
  if ((mod & 1) && cp >= 97 && cp <= 122) ch = ch.toUpperCase()

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
    const raw = toRawAnsi(data)
    this.session.write(raw !== undefined ? raw : Buffer.from(data, "utf-8"))
  }

  wantsKeyRelease = false

  invalidate(): void {
    // handled by tui.requestRender
  }

  dispose(): void {
    this.session.close()
  }
}
