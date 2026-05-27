import type { Theme } from "@earendil-works/pi-coding-agent"
import { Key, decodeKittyPrintable, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { formatTipMessage } from "./tip-row.js"
import type { TipCandidate } from "./types.js"

interface TipGroup {
	label: string
	source: string
	tips: TipCandidate[]
}

const KNOWN_LABELS: Record<string, string> = {
	"kimchi.general": "General",
	"kimchi.ferment": "Ferment",
}

export function sourceToLabel(source: string): string {
	const known = KNOWN_LABELS[source]
	if (known) return known
	const name = source.startsWith("kimchi.") ? source.slice(7) : source
	return name.charAt(0).toUpperCase() + name.slice(1)
}

function tipContainsQuery(query: string, message: string): boolean {
	return message.toLowerCase().includes(query.toLowerCase())
}

function groupTips(tips: TipCandidate[]): TipGroup[] {
	const seen = new Map<string, TipGroup>()
	const order: TipGroup[] = []

	for (const tip of tips) {
		let group = seen.get(tip.source)
		if (!group) {
			group = { label: sourceToLabel(tip.source), source: tip.source, tips: [] }
			seen.set(tip.source, group)
			order.push(group)
		}
		group.tips.push(tip)
	}

	return order
}

// The overlay maxHeight percentage — must match overlayOptions in the caller.
const MAX_HEIGHT_PCT = 0.9

// Lines outside the scrollable viewport:
//   top border (1) + empty (1) + search row (1) + empty (1) + divider (1) +
//   divider (1) + empty (1) + hint (1) + bottom border (1) = 9
const CHROME_LINES = 9

function buildDisplayLines(groups: TipGroup[], theme: Theme, contentWidth: number): string[] {
	const lines: string[] = []
	const italic = (s: string) => `\x1b[3m${s}\x1b[23m`

	if (groups.length === 0 || groups.every((g) => g.tips.length === 0)) {
		lines.push("")
		lines.push(theme.fg("dim", italic("  No tips available.")))
		lines.push("")
		return lines
	}

	let tipNumber = 1
	for (let gi = 0; gi < groups.length; gi++) {
		const group = groups[gi]
		if (group.tips.length === 0) continue

		// Blank line before each group (including first, for spacing after divider)
		lines.push("")

		// Group header
		lines.push(`  \x1b[1m${theme.fg("text", group.label)}\x1b[22m`)

		for (const tip of group.tips) {
			const numStr = `${tipNumber}.`
			const prefix = `  ${numStr} `
			const prefixWidth = 2 + numStr.length + 1 // "  " + "N." + " "
			const indentStr = " ".repeat(prefixWidth)

			const formatted = formatTipMessage(tip.message, theme)
			const messageWidth = Math.max(8, contentWidth - prefixWidth)
			const wrapped = wrapTextWithAnsi(formatted, messageWidth)

			if (wrapped.length > 0) {
				lines.push(prefix + wrapped[0])
				for (let i = 1; i < wrapped.length; i++) {
					lines.push(indentStr + wrapped[i])
				}
			} else {
				lines.push(prefix)
			}

			tipNumber++
		}
	}

	// Trailing blank for spacing before bottom divider
	lines.push("")

	return lines
}

export function createTipsPanel(
	tips: TipCandidate[],
	theme: Theme,
	tui: { requestRender(force?: boolean): void; terminal: { rows: number } },
	done: (result: undefined) => void,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	const allGroups = groupTips(tips)
	let searchQuery = ""
	let scrollOffset = 0
	let lastContentW = 60

	function getFilteredGroups(): TipGroup[] {
		if (!searchQuery) return allGroups
		return allGroups
			.map((group) => ({
				...group,
				tips: group.tips.filter((tip) => tipContainsQuery(searchQuery, tip.message)),
			}))
			.filter((group) => group.tips.length > 0)
	}

	function viewportHeight(): number {
		const overlayMax = Math.floor(tui.terminal.rows * MAX_HEIGHT_PCT)
		return Math.max(1, overlayMax - CHROME_LINES)
	}

	return {
		render(width: number): string[] {
			const innerW = Math.max(20, width - 2)
			const contentW = innerW - 2 // 1 space padding on each side
			lastContentW = contentW

			const filteredGroups = getFilteredGroups()
			const contentLines = buildDisplayLines(filteredGroups, theme, contentW)
			const vp = viewportHeight()
			const maxScroll = Math.max(0, contentLines.length - vp)
			if (scrollOffset > maxScroll) scrollOffset = maxScroll

			const hasScroll = contentLines.length > vp
			const border = (s: string) => theme.fg("border", s)
			const italic = (s: string) => `\x1b[3m${s}\x1b[23m`

			const wrapRow = (colored: string, rawLen: number) =>
				`${border("│")} ${colored}${" ".repeat(Math.max(0, contentW - rawLen))} ${border("│")}`

			const wrapRowAnsi = (ansiContent: string) => {
				const vw = visibleWidth(ansiContent)
				const pad = Math.max(0, contentW - vw)
				return `${border("│")} ${ansiContent}${" ".repeat(pad)} ${border("│")}`
			}

			const emptyRow = () => `${border("│")}${" ".repeat(innerW)}${border("│")}`

			// Top border with title
			const titleText = " Tips "
			const borderLen = innerW - titleText.length
			const leftB = Math.floor(borderLen / 2)
			const rightB = borderLen - leftB
			const out: string[] = []
			out.push(`${border(`╭${"─".repeat(leftB)}`)}${theme.fg("dim", titleText)}${border(`${"─".repeat(rightB)}╮`)}`)

			// Search bar
			out.push(emptyRow())
			const searchIcon = theme.fg("border", "◎")
			const cursor = theme.fg("accent", "│")
			if (searchQuery) {
				out.push(wrapRowAnsi(`${searchIcon}  ${searchQuery}${cursor}`))
			} else {
				out.push(wrapRowAnsi(`${searchIcon}  ${theme.fg("dim", italic("Type to search"))}`))
			}
			out.push(emptyRow())

			// Divider
			out.push(border(`├${"─".repeat(innerW)}┤`))

			// Content viewport
			const showUp = scrollOffset > 0
			const showDown = scrollOffset < maxScroll
			const visible = contentLines.slice(scrollOffset, scrollOffset + vp)

			for (let i = 0; i < visible.length; i++) {
				const line = visible[i]
				if (i === 0 && showUp) {
					const ind = `↑ ${scrollOffset} more`
					out.push(wrapRow(theme.fg("dim", ind), ind.length))
				} else if (i === visible.length - 1 && showDown) {
					const remaining = contentLines.length - scrollOffset - vp
					const ind = `↓ ${remaining} more`
					out.push(wrapRow(theme.fg("dim", ind), ind.length))
				} else if (line === "") {
					out.push(emptyRow())
				} else {
					out.push(wrapRowAnsi(line))
				}
			}

			// Bottom divider
			out.push(border(`├${"─".repeat(innerW)}┤`))

			// Footer hints
			out.push(emptyRow())
			const scrollHint = hasScroll ? " · ↑↓ to scroll" : ""
			const hintText = `Esc/Enter to close${scrollHint}`
			out.push(wrapRow(theme.fg("dim", `  ${hintText}`), hintText.length + 2))

			// Bottom border
			out.push(border(`╰${"─".repeat(innerW)}╯`))

			return out
		},

		handleInput(data: string): void {
			if (matchesKey(data, "ctrl+c")) {
				done(undefined)
				return
			}

			if (matchesKey(data, Key.escape)) {
				if (searchQuery) {
					searchQuery = ""
					scrollOffset = 0
					tui.requestRender()
					return
				}
				done(undefined)
				return
			}

			if (matchesKey(data, Key.enter)) {
				if (!searchQuery) {
					done(undefined)
					return
				}
				// With an active search, Enter is a no-op (don't close)
				return
			}

			if (matchesKey(data, Key.up)) {
				scrollOffset = Math.max(0, scrollOffset - 1)
				tui.requestRender()
				return
			}

			if (matchesKey(data, Key.down)) {
				const filteredGroups = getFilteredGroups()
				const lines = buildDisplayLines(filteredGroups, theme, lastContentW).length
				const maxScroll = Math.max(0, lines - viewportHeight())
				scrollOffset = Math.min(maxScroll, scrollOffset + 1)
				tui.requestRender()
				return
			}

			if (matchesKey(data, Key.pageUp)) {
				const vp = viewportHeight()
				scrollOffset = Math.max(0, scrollOffset - vp)
				tui.requestRender()
				return
			}

			if (matchesKey(data, Key.pageDown)) {
				const vp = viewportHeight()
				const filteredGroups = getFilteredGroups()
				const lines = buildDisplayLines(filteredGroups, theme, lastContentW).length
				const maxScroll = Math.max(0, lines - vp)
				scrollOffset = Math.min(maxScroll, scrollOffset + vp)
				tui.requestRender()
				return
			}

			// Backspace must be checked BEFORE Kitty printable decode.
			// Kitty sends backspace as \x1b[127u which decodeKittyPrintable would
			// incorrectly treat as a printable character.
			if (matchesKey(data, "backspace")) {
				if (searchQuery.length > 0) {
					searchQuery = searchQuery.slice(0, -1)
					scrollOffset = 0
					tui.requestRender()
				}
				return
			}

			// Printable characters → search
			// Kitty protocol CSI-u sequences (e.g. \x1b[103u for 'g')
			const kittyPrintable = decodeKittyPrintable(data)
			if (kittyPrintable !== undefined) {
				searchQuery += kittyPrintable
				scrollOffset = 0
				tui.requestRender()
				return
			}
			// Regular character input - accept printable characters including Unicode,
			// but reject control characters
			const hasControlChars = [...data].some((ch) => {
				const code = ch.charCodeAt(0)
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
			})
			if (!hasControlChars && data.length > 0) {
				searchQuery += data
				scrollOffset = 0
				tui.requestRender()
				return
			}
		},

		invalidate(): void {},
	}
}
