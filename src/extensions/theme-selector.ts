/**
 * theme-selector — Provides a `/theme` command to switch themes.
 *
 * Mirrors the theme selection from /settings but exposes it as a root-level
 * command for quick access. Supports live preview when navigating themes.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { type Theme, getSelectListTheme } from "@earendil-works/pi-coding-agent"
import {
	Container,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Spacer,
	type TUI,
	Text,
} from "@earendil-works/pi-tui"

// Mirror of upstream's private SETTINGS_SUBMENU_SELECT_LIST_LAYOUT constant
// (defined inline in dist/modes/interactive/components/settings-selector.js).
// Used so the theme picker renders with the same column widths as the
// /settings → Theme submenu. Not exported upstream.
const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
}

// Runtime-only UI helpers that are not yet exported from the upstream
// ExtensionUIContext type. The casts are isolated here and guarded at runtime
// so the code fails gracefully if the contract drifts.
function getPreviewTheme(ui: ExtensionCommandContext["ui"]): ((name: string) => void) | undefined {
	const candidate = ui as unknown as { previewTheme?: (name: string) => void }
	return typeof candidate.previewTheme === "function" ? candidate.previewTheme : undefined
}

function getShowError(ui: ExtensionCommandContext["ui"]): ((message: string) => void) | undefined {
	const candidate = ui as unknown as { showError?: (message: string) => void }
	return typeof candidate.showError === "function" ? candidate.showError : undefined
}

// Inline copy of pi-coding-agent's private DynamicBorder component
// (dist/modes/interactive/components/dynamic-border.js). Re-implemented
// locally because:
//   - It's not exported from @earendil-works/pi-tui's public API.
//   - The upstream component relies on a module-local `theme` import that
//     is undefined when pi-coding-agent is loaded via jiti (the extension
//     loader), per the source's own warning.
// Behaviour matches upstream: a single horizontal rule that adapts to width.
class DynamicBorder {
	private readonly color: (str: string) => string
	constructor(color: (str: string) => string = (s) => s) {
		this.color = color
	}
	invalidate() {
		// No cached state.
	}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))]
	}
}

export default function themeSelectorExtension(pi: ExtensionAPI) {
	pi.registerCommand("theme", {
		description: "Select color theme",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return
			const ui = ctx.ui
			const themes = ui.getAllThemes()
			const currentThemeName = ui.theme.name

			// Build items: all available themes, in upstream order.
			const items: SelectItem[] = themes.map((theme) => ({
				value: theme.name,
				label: theme.name,
			}))

			// Find initial selection index (current theme)
			const currentIndex = items.findIndex((item) => item.value === currentThemeName)

			await ui.custom((tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (_result?: unknown) => void) => {
				const container = new Container()

				// Border above title
				container.addChild(new DynamicBorder())

				// Title
				container.addChild(new Text(theme.bold(theme.fg("accent", "Theme")), 0, 0))

				// Description
				container.addChild(new Spacer(1))
				container.addChild(new Text(theme.fg("muted", "Select color theme"), 0, 0))

				// Spacer
				container.addChild(new Spacer(1))

				const selectList = new SelectList(
					items,
					Math.min(items.length, 10),
					getSelectListTheme(),
					SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
				)

				// Pre-select current theme
				if (currentIndex !== -1) {
					selectList.setSelectedIndex(currentIndex)
				}

				// Preview theme on navigation (hover/arrow keys)
				selectList.onSelectionChange = (item) => {
					getPreviewTheme(ui)?.(item.value)
				}

				// Finalize selection on Enter
				selectList.onSelect = (item) => {
					const result = ui.setTheme(item.value)
					if (!result.success) {
						getShowError(ui)?.(`Failed to load theme "${item.value}": ${result.error}\nFell back to dark theme.`)
					}
					done()
				}

				selectList.onCancel = () => {
					// Restore original theme on cancel (no persist, mirrors /settings onThemePreview).
					// Guard: Theme.name is optional; skip the preview if there is no name to restore.
					if (currentThemeName) {
						getPreviewTheme(ui)?.(currentThemeName)
					}
					done()
				}

				container.addChild(selectList)

				// Hint footer
				container.addChild(new Spacer(1))
				container.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0))

				// Border below hint
				container.addChild(new DynamicBorder())

				return {
					render(width: number) {
						return container.render(width)
					},
					invalidate() {
						container.invalidate()
					},
					handleInput(data: string) {
						selectList.handleInput?.(data)
						tui.requestRender()
					},
				}
			})
		},
	})
}
