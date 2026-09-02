import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { RST_FG } from "../ansi.js"
import { getVersion } from "../utils.js"
import { buildCompactLogoLines, buildInfoLines, buildLogoLines } from "./logo-art.js"

// Box chrome: left border + divider + right border ("│" × 3).
const CHROME = 3
// Spaces flanking the right-cell text.
const CELL_PAD = 1
// Minimum readable tip measure for the right column.
const RIGHT_MIN = 12
// Maximum per-side symmetric gutter around the logo content.
const GUTTER_MAX = 10
// Minimum per-side gutter the full word-art needs to stay comfortably readable.
const MIN_GUTTER = 1

export interface HeaderLayout {
	span: number
	rightColWidth: number
}

/**
 * Compute the two-cell header layout for a requested terminal width.
 *
 * The right column is granted at least `RIGHT_MIN` columns and then takes
 * all remaining width. The logo cell keeps up to `GUTTER_MAX` columns of
 * symmetric gutter on each side, which caps the logo cell at the same
 * 56-col maximum the old pad cascade had (10 + 36 + 10). At degenerate
 * widths the right column is clamped to 1 and the final tail-truncation in
 * the caller absorbs the overflow.
 */
export function computeHeaderLayout(width: number, logoWidth: number): HeaderLayout {
	const slack = width - CHROME - 2 * CELL_PAD - logoWidth - RIGHT_MIN
	let gutter = slack >= 0 ? Math.min(GUTTER_MAX, Math.floor(slack / 2)) : 0
	let rightColWidth = width - CHROME - 2 * CELL_PAD - logoWidth - 2 * gutter
	// Degenerate widths (e.g. < 26 for compact) can't honour all floors.
	if (rightColWidth < 1) {
		rightColWidth = Math.max(1, width - CHROME - 2 * CELL_PAD - logoWidth)
		gutter = 0
	}
	const span = Math.max(logoWidth, logoWidth + 2 * gutter)
	return { span, rightColWidth }
}

export class LogoHeader implements Component {
	private readonly theme: Theme
	private readonly getBranch?: () => string | undefined
	private readonly getRightColumnNotice?: () => string | undefined
	private logoLines!: string[]
	private compactLogoLines!: string[]

	constructor(theme: Theme, opts?: { getBranch?(): string | undefined; getRightColumnNotice?(): string | undefined }) {
		this.theme = theme
		this.getBranch = opts?.getBranch
		this.getRightColumnNotice = opts?.getRightColumnNotice
		this.rebuildArt()
	}

	invalidate(): void {
		this.rebuildArt()
	}

	private rebuildArt(): void {
		this.logoLines = buildLogoLines(this.theme)
		this.compactLogoLines = buildCompactLogoLines(this.theme)
	}

	render(width: number): string[] {
		const { theme } = this
		const accentOpen = theme.getFgAnsi("accent")

		// The header is a two-cell box: a left cell holding the logo + info
		// lines, and a right cell holding the tips. The left cell's content
		// is always horizontally centered in its span, which gives the logo
		// symmetric gutters that grow smoothly with width and collapses
		// gracefully when the right column claims more space.

		// Variant. The full word-art only fits comfortably when we can afford
		// at least MIN_GUTTER on each side of the logo and RIGHT_MIN for the
		// tips; below that, switch to the pepper-only mark.
		const fullLogoWidth = Math.max(...this.logoLines.map((l) => visibleWidth(l)))
		const isCompact = width < fullLogoWidth + CHROME + 2 * CELL_PAD + RIGHT_MIN + 2 * MIN_GUTTER
		const logoLines = isCompact ? this.compactLogoLines : this.logoLines
		const logoWidth = Math.max(...logoLines.map((l) => visibleWidth(l)))
		const logoHeight = logoLines.length
		const midGap = 2

		// Allocation. Give the right column a bounded measure; let the logo
		// cell keep up to GUTTER_MAX of symmetric padding on each side; once
		// the right column hits RIGHT_MAX, any remaining slack returns to the
		// gutters so the box stays centered at very wide widths.
		const { span, rightColWidth } = computeHeaderLayout(width, logoWidth)

		// Compute how much room the version prefix takes so we can tell
		// buildInfoLines how much space remains for the folder before the
		// whole line would exceed the left column width.
		const versionStr = getVersion()
		const versionPrefixWidth = 1 + versionStr.length + 3 // "v" + version + " · "
		const folderMaxWidth = Math.max(4, span - versionPrefixWidth)

		const infoLines = buildInfoLines(theme, { folderMaxWidth, getBranch: this.getBranch })

		// Truncate each info line so it never exceeds the left column width.
		const infoLinesFitted = infoLines.map((line) => {
			const w = visibleWidth(line)
			return w > span ? truncateToWidth(line, span) : line
		})

		// Right column content (static text — no dynamic tip mechanism exists yet)
		const accentText = (text: string) => theme.fg("accent", text)
		const labelLine = "Kimchi's special:"
		const tip1Text = `Use ${accentText("/ferment")} to hand off a large task with minimal interruption.`
		const tip2Text =
			this.getRightColumnNotice?.() ??
			`To leave the Ferment mode and return to a regular coding session, use ${accentText("/ferment exit")}.`

		const labelWrap = wrapTextWithAnsi(labelLine, rightColWidth)
		const wrap1 = wrapTextWithAnsi(tip1Text, rightColWidth)
		const wrap2 = wrapTextWithAnsi(tip2Text, rightColWidth)
		const hrLine = accentOpen + "─".repeat(Math.max(0, rightColWidth)) + RST_FG

		const rightLines: string[] = [...labelWrap, ...wrap1, hrLine, ...wrap2]

		// Left column: generous vertical padding plus centered logo + info lines
		const infoLineCount = infoLinesFitted.length
		const unitHeight = logoHeight + midGap + infoLineCount
		const minVerticalPad = 2
		const leftContentHeight = unitHeight + 2 * minVerticalPad
		const totalHeight = Math.max(rightLines.length, leftContentHeight)

		const logoTop = Math.floor((totalHeight - unitHeight) / 2)
		const infoRowStart = logoTop + logoHeight + midGap

		const accentBorder = (char: string) => accentOpen + char + RST_FG
		const result: string[] = []

		// Top border
		const borderInner = Math.max(0, width - 2)
		result.push(accentBorder(`┌${"─".repeat(borderInner)}┐`))

		for (let row = 0; row < totalHeight; row++) {
			let leftContent = ""
			if (row >= logoTop && row < logoTop + logoHeight) {
				leftContent = logoLines[row - logoTop]
			}
			if (row >= infoRowStart && row < infoRowStart + infoLineCount) {
				leftContent = infoLinesFitted[row - infoRowStart]
			}

			// Horizontally center content within the left cell span.
			const contentWidth = visibleWidth(leftContent)
			const hPad = Math.floor((span - contentWidth) / 2)
			const leftPadded = " ".repeat(hPad) + leftContent + " ".repeat(span - contentWidth - hPad)

			const rightContent = rightLines[row] || ""
			const rightVisible = visibleWidth(rightContent)
			const rightPadded = rightContent + " ".repeat(Math.max(0, rightColWidth - rightVisible))

			const line =
				accentBorder("│") +
				leftPadded +
				accentBorder("│") +
				" ".repeat(CELL_PAD) +
				rightPadded +
				" ".repeat(CELL_PAD) +
				accentBorder("│")

			result.push(line)
		}

		// Bottom border
		result.push(accentBorder(`└${"─".repeat(borderInner)}┘`))

		// On terminals narrower than the logo every body line would overflow;
		// pi-tui treats an over-wide line as a fatal crash, so hard-truncate
		// every row here.
		return result.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line))
	}
}
