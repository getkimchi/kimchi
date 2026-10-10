import type { Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui"
import type { WorkBrowser } from "./browser.js"

const MAX_VISIBLE = 10
const MIN_LABEL_WIDTH = 12
const MAX_LABEL_WIDTH = 64

/** Settings-style list of works: Enter resolves with the selected work ID, Esc with none. */
export class WorkBrowserPanel implements Component {
	private readonly items: SettingItem[]
	private readonly list: SettingsList
	private labelsWidth = 0

	constructor(
		private readonly browser: WorkBrowser,
		private readonly theme: Theme,
		done: (workId?: string) => void,
	) {
		// A single value makes Enter report the row instead of changing a setting.
		this.items = browser.rows.map((row) => ({
			id: row.workId,
			label: row.label,
			description: row.description,
			currentValue: row.value,
			values: [row.value],
		}))
		this.list = new SettingsList(
			this.items,
			MAX_VISIBLE,
			listTheme(theme),
			(workId) => done(workId),
			() => done(),
		)
	}

	render(width: number): string[] {
		const theme = this.theme
		const { rows, spend } = this.browser
		const lineWidth = Math.max(1, width)
		this.fitLabels(lineWidth)
		const separator = theme.fg("dim", " · ")
		const rule = theme.fg("accent", "─".repeat(lineWidth))
		const works = `${rows.length} work${rows.length === 1 ? "" : "s"}`
		return [
			rule,
			` ${theme.bold(theme.fg("text", "Kimchi work"))}${separator}${theme.fg("text", works)}${separator}${theme.fg("text", spend)}`,
			` ${theme.fg("dim", "Current:")} ${theme.fg("text", rows[0].label)}`,
			"",
			// SettingsList ends with its own "Enter/Space to change" hint; this panel prints details instead.
			...this.list.render(lineWidth).slice(0, -2),
			"",
			theme.fg("dim", " ↑↓ select · Enter print details · Esc close"),
			rule,
		].map((line) => truncateToWidth(line, lineWidth, "…"))
	}

	handleInput(data: string): void {
		this.list.handleInput(data)
	}

	invalidate(): void {
		this.list.invalidate()
	}

	/**
	 * SettingsList aligns labels in a column of at most 36 cells and cuts values to fit. Equal-width labels
	 * keep values aligned in a wider column too, and labels give way first so a PR number is never cut.
	 */
	private fitLabels(width: number): void {
		if (width === this.labelsWidth) return
		this.labelsWidth = width
		const { rows } = this.browser
		const valueWidth = Math.max(...rows.map((row) => visibleWidth(row.value)))
		const longest = Math.max(...rows.map((row) => visibleWidth(row.label)))
		// Around the label column the list draws a 2-cell cursor, a 2-cell gap and a 2-cell margin.
		const labelWidth = Math.max(MIN_LABEL_WIDTH, Math.min(MAX_LABEL_WIDTH, longest, width - valueWidth - 6))
		for (const [index, item] of this.items.entries())
			item.label = truncateToWidth(rows[index].label, labelWidth, "…", true)
	}
}

/** Uses the theme passed to the panel, with readable text for the values and details. */
function listTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => theme.fg(selected ? "accent" : "text", text),
		description: (text) => theme.fg("text", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	}
}
