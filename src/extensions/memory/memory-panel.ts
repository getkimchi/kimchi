/**
 * Interactive memory browser — the in-session /memory list|search surface.
 * An McpPanel-style component (render + handleInput) mounted through
 * ctx.ui.custom: page through facts with ↑↓/j/k (PgUp/PgDn, g/G), delete
 * the selected fact with `d`, quit with q/Esc/Ctrl+C. The CLI grammar is
 * unchanged — this is the session-side view over the same admin core
 * (admin.ts). Deletion is user-only and immediate.
 */
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { fg } from "../../ansi.js"
import type { AdminFact } from "./admin.js"

export interface MemoryPanelFact extends AdminFact {
	/** Search hits carry their score. */
	score?: number
}

export interface MemoryPanelOptions {
	/** Shown centered in the panel border, e.g. `Memory — 42 facts`. */
	title: string
	facts: MemoryPanelFact[]
	/** Delete one fact by id; resolves with the scope it was deleted from, rejects on failure. */
	deleteFact: (id: string) => Promise<string>
	tui: { requestRender(force?: boolean): void; terminal: { rows: number } }
	done: () => void
}

const MAX_VISIBLE = 20
const MIN_VISIBLE = 3
// Border rows, title spacing, legend, divider, notice, empty padding.
const FIXED_OVERHEAD_ROWS = 8
const SCOPE_COLUMN_MAX = 20

const THEME = {
	border: "2",
	title: "2",
	selected: "36",
	dim: "2",
	hint: "2",
	notice: "36",
	error: "1",
} as const

/**
 * The visible-row window: adapts to the terminal height so the legend and
 * notice stay on-screen, sliding to keep the cursor roughly centered.
 */
export function computeMemoryWindow(
	terminalRows: number,
	cursorIndex: number,
	total: number,
): { maxVis: number; startIdx: number; endIdx: number } {
	const maxVis = Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, terminalRows - FIXED_OVERHEAD_ROWS))
	const startIdx = Math.max(0, Math.min(cursorIndex - Math.floor(maxVis / 2), total - maxVis))
	const endIdx = Math.min(startIdx + maxVis, total)
	return { maxVis, startIdx, endIdx }
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

export class MemoryPanel {
	private facts: MemoryPanelFact[]
	private cursorIndex = 0
	private notice: { text: string; error: boolean } | null = null
	private deleting = false

	constructor(private readonly options: MemoryPanelOptions) {
		this.facts = [...options.facts]
	}

	handleInput(data: string): void {
		// Any key dismisses the current notice; a delete sets a fresh one.
		this.notice = null
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.options.done()
			return
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.move(-1)
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.move(1)
		} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.setCursor(0)
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.setCursor(this.facts.length - 1)
		} else if (matchesKey(data, "pageUp")) {
			this.move(-this.window().maxVis)
		} else if (matchesKey(data, "pageDown")) {
			this.move(this.window().maxVis)
		} else if (matchesKey(data, "d")) {
			void this.deleteSelected()
		}
	}

	invalidate(): void {
		// No cached render state to invalidate.
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2)
		const lines: string[] = []
		const row = (content: string) =>
			fg(THEME.border, "│") + truncateToWidth(` ${content}`, innerW, "…", true) + fg(THEME.border, "│")
		const emptyRow = () => fg(THEME.border, "│") + " ".repeat(innerW) + fg(THEME.border, "│")
		const divider = () => fg(THEME.border, `├${"─".repeat(innerW)}┤`)

		const titleText = ` ${this.options.title} `
		const borderLen = Math.max(0, innerW - visibleWidth(titleText))
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(
			fg(THEME.border, `╭${"─".repeat(leftB)}`) +
				fg(THEME.title, titleText) +
				fg(THEME.border, `${"─".repeat(rightB)}╮`),
		)
		lines.push(emptyRow())

		if (this.facts.length === 0) {
			lines.push(row(fg(THEME.dim, "No memories to show.")))
			lines.push(emptyRow())
		} else {
			const total = this.facts.length
			const { startIdx, endIdx } = this.window()
			const scopeWidth = Math.min(
				SCOPE_COLUMN_MAX,
				Math.max(8, ...this.facts.slice(startIdx, endIdx).map((f) => f.scopeId.length)),
			)
			for (let i = startIdx; i < endIdx; i++) {
				lines.push(row(this.renderFactRow(this.facts[i] as MemoryPanelFact, i === this.cursorIndex, scopeWidth)))
			}
			if (endIdx - startIdx < total) {
				lines.push(row(fg(THEME.dim, `… ${total - (endIdx - startIdx)} more (PgDn · G for the end)`)))
			}
			lines.push(emptyRow())
			lines.push(row(fg(THEME.hint, `${this.cursorIndex + 1}/${total}  ·  ↑↓ move  d delete  q quit`)))
		}

		lines.push(divider())
		const notice = this.notice
		const footer = notice
			? fg(notice.error ? THEME.error : THEME.notice, notice.text)
			: fg(THEME.hint, "Deletion is immediate and permanent.")
		lines.push(row(footer))
		lines.push(fg(THEME.border, `╰${"─".repeat(innerW)}╯`))
		return lines
	}

	private renderFactRow(fact: MemoryPanelFact, isCursor: boolean, scopeWidth: number): string {
		const date = (fact.updatedAt ?? fact.createdAt ?? "").slice(0, 10) || "----------"
		const scope = truncateToWidth(fact.scopeId.padEnd(scopeWidth), scopeWidth, "…")
		const text = oneLine(fact.memory)
		const marker = isCursor ? fg(THEME.selected, "→") : " "
		const columns = `${marker} ${fg(THEME.dim, date)} ${fg(THEME.dim, scope)}  `
		// The selected row keeps the fact text in the selected color so the
		// delete target is unambiguous.
		return isCursor ? `${columns}${fg(THEME.selected, text)}` : `${columns}${text}`
	}

	private window(): { maxVis: number; startIdx: number; endIdx: number } {
		return computeMemoryWindow(this.options.tui.terminal.rows, this.cursorIndex, this.facts.length)
	}

	private move(delta: number): void {
		this.setCursor(this.cursorIndex + delta)
	}

	private setCursor(index: number): void {
		this.cursorIndex = Math.max(0, Math.min(index, Math.max(0, this.facts.length - 1)))
		this.options.tui.requestRender()
	}

	private async deleteSelected(): Promise<void> {
		const fact = this.facts[this.cursorIndex]
		if (!fact || this.deleting) return
		this.deleting = true
		// Optimistic removal keeps the panel responsive; restore on failure —
		// at the ORIGINAL index, so a failed delete never reorders the list.
		const originalIndex = this.cursorIndex
		this.facts.splice(this.cursorIndex, 1)
		if (this.cursorIndex >= this.facts.length) this.cursorIndex = Math.max(0, this.facts.length - 1)
		this.options.tui.requestRender()
		try {
			const scope = await this.options.deleteFact(fact.id)
			this.notice = { text: `Deleted from ${scope}: ${oneLine(fact.memory).slice(0, 60)}`, error: false }
		} catch (err) {
			this.facts.splice(originalIndex, 0, fact)
			this.notice = {
				text: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
				error: true,
			}
		} finally {
			this.deleting = false
			this.options.tui.requestRender()
		}
	}
}
