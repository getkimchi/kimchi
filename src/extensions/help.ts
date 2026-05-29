import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Key, isKeyRelease, matchesKey, visibleWidth } from "@earendil-works/pi-tui"

type HelpRow = { kind: "heading"; text: string } | { kind: "entry"; key: string; desc: string } | { kind: "spacer" }

const HELP_ROWS: HelpRow[] = [
	{ kind: "heading", text: "Keyboard Shortcuts" },
	{ kind: "entry", key: "Enter", desc: "Submit prompt" },
	{ kind: "entry", key: "Shift+Enter / Ctrl+J", desc: "Newline in input" },
	{ kind: "entry", key: "Up/Down", desc: "Navigate input history" },
	{ kind: "entry", key: "Escape", desc: "Close dialog / Abort running agent" },
	{ kind: "entry", key: "Ctrl+C", desc: "Clear input / Abort running agent" },
	{ kind: "entry", key: "Ctrl+P", desc: "Cycle to next model" },
	{ kind: "entry", key: "Shift+Tab", desc: "Change permissions mode" },

	{ kind: "spacer" },
	{ kind: "heading", text: "Slash Commands" },
	{ kind: "entry", key: "/settings", desc: "Open settings menu" },
	{ kind: "entry", key: "/model", desc: "Switch to a specific model" },
	{ kind: "entry", key: "/scoped-models", desc: "Enable or disable models for Ctrl+P cycling" },
	{ kind: "entry", key: "/multi-model", desc: "Configure model roles" },
	{ kind: "entry", key: "/ferment", desc: "Run task in background" },
	{ kind: "entry", key: "/compact", desc: "Compact context window" },
	{ kind: "entry", key: "/new", desc: "Start a new session" },
	{ kind: "entry", key: "/agents", desc: "Manage background agents" },
	{ kind: "entry", key: "/permissions", desc: "View or change permission mode and rules" },
	{ kind: "entry", key: "/phase", desc: "Show or change the current work phase" },
	{ kind: "entry", key: "/bug", desc: "Report a bug — opens GitHub issue form" },
	{ kind: "entry", key: "/stats", desc: "View coding analytics and metrics" },
	{ kind: "entry", key: "/mcp", desc: "Show MCP server status" },
	{ kind: "entry", key: "/resources", desc: "Manage resources (files, URLs, images)" },
	{ kind: "entry", key: "/tags", desc: "Manage usage tracking tags" },
	{ kind: "entry", key: "/tips", desc: "Show all tips" },
	{ kind: "entry", key: "/help", desc: "Show this help" },
	{ kind: "entry", key: "/exit", desc: "Exit the application" },
]

// The overlay maxHeight percentage — must match overlayOptions below.
const MAX_HEIGHT_PCT = 0.9

// Lines outside the scrollable viewport:
//   top border (1) + footer empty row (1) + footer hint (1) + bottom border (1)
const CHROME_LINES = 4

export default function helpExtension(pi: ExtensionAPI) {
	pi.registerCommand("help", {
		description: "Show keyboard shortcuts and slash commands",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const lines: string[] = []
				for (const row of HELP_ROWS) {
					if (row.kind === "heading") {
						lines.push(`\n${row.text}`)
					} else if (row.kind === "entry") {
						lines.push(`  ${row.key.padEnd(20)} ${row.desc}`)
					}
				}
				ctx.ui.notify(lines.join("\n").trim(), "info")
				return
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					let scrollOffset = 0

					function viewportHeight(): number {
						// Derive available rows from the same maxHeight the overlay uses,
						// then subtract chrome so the bottom border is never clipped.
						const overlayMax = Math.floor(tui.terminal.rows * MAX_HEIGHT_PCT)
						return Math.max(1, overlayMax - CHROME_LINES)
					}

					function buildContentLines(keyColW: number): Array<[string, number]> {
						const lines: Array<[string, number]> = []
						for (const row of HELP_ROWS) {
							if (row.kind === "spacer") {
								lines.push(["", 0])
							} else if (row.kind === "heading") {
								lines.push([theme.fg("text", row.text), visibleWidth(row.text)])
							} else {
								const keyStr = row.key.padEnd(keyColW)
								const rawText = `${keyStr} ${row.desc}`
								const colored = `${theme.fg("accent", keyStr)} ${theme.fg("muted", row.desc)}`
								lines.push([colored, visibleWidth(rawText)])
							}
						}
						return lines
					}

					return {
						render(width: number): string[] {
							const innerW = Math.max(20, width - 2)
							const contentW = innerW - 2
							const keyColW = Math.max(16, Math.min(28, Math.floor(contentW * 0.35)))

							const contentLines = buildContentLines(keyColW)
							const vp = viewportHeight()
							const maxScroll = Math.max(0, contentLines.length - vp)
							if (scrollOffset > maxScroll) scrollOffset = maxScroll

							const hasScroll = contentLines.length > vp
							const border = (s: string) => theme.fg("border", s)
							const wrapRow = (colored: string, rawLen: number) =>
								`${border("│")} ${colored}${" ".repeat(Math.max(0, contentW - rawLen))} ${border("│")}`
							const emptyRow = () => `${border("│")}${" ".repeat(innerW)}${border("│")}`

							const titleText = " Help "
							const borderLen = innerW - titleText.length
							const leftB = Math.floor(borderLen / 2)
							const rightB = borderLen - leftB

							const out: string[] = []

							// Top border with title
							out.push(
								`${border(`╭${"─".repeat(leftB)}`)}${theme.fg("dim", titleText)}${border(`${"─".repeat(rightB)}╮`)}`,
							)

							// Scrollable content
							const showUp = scrollOffset > 0
							const showDown = scrollOffset < maxScroll
							const visible = contentLines.slice(scrollOffset, scrollOffset + vp)

							for (let i = 0; i < visible.length; i++) {
								const [colored, rawLen] = visible[i]
								if (i === 0 && showUp) {
									const ind = `↑ ${scrollOffset} more`
									out.push(wrapRow(theme.fg("dim", ind), ind.length))
								} else if (i === visible.length - 1 && showDown) {
									const remaining = contentLines.length - scrollOffset - vp
									const ind = `↓ ${remaining} more`
									out.push(wrapRow(theme.fg("dim", ind), ind.length))
								} else if (rawLen === 0) {
									out.push(emptyRow())
								} else {
									out.push(wrapRow(colored, rawLen))
								}
							}

							// Footer (always rendered, outside scrollable area)
							out.push(emptyRow())
							const scrollHint = hasScroll ? " · ↑↓ to scroll" : ""
							const hintText = `Esc/Enter to close${scrollHint}`
							out.push(wrapRow(theme.fg("dim", `  ${hintText}`), hintText.length + 2))
							out.push(border(`╰${"─".repeat(innerW)}╯`))

							return out
						},
						invalidate() {},
						handleInput(data: string): void {
							if (isKeyRelease(data)) return
							if (
								matchesKey(data, Key.escape) ||
								matchesKey(data, Key.enter) ||
								matchesKey(data, "return") ||
								data === "q"
							) {
								done(undefined)
								return
							}
							const contentLen = HELP_ROWS.length
							const vp = viewportHeight()
							const maxScroll = Math.max(0, contentLen - vp)
							if (matchesKey(data, Key.up) || data === "k") {
								scrollOffset = Math.max(0, scrollOffset - 1)
							} else if (matchesKey(data, Key.down) || data === "j") {
								scrollOffset = Math.min(maxScroll, scrollOffset + 1)
							} else if (matchesKey(data, Key.pageUp)) {
								scrollOffset = Math.max(0, scrollOffset - vp)
							} else if (matchesKey(data, Key.pageDown)) {
								scrollOffset = Math.min(maxScroll, scrollOffset + vp)
							}
						},
						wantsKeyRelease: false,
					}
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" },
				},
			)
		},
	})
}
