import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { Key, isKeyRelease, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
import { FOOTER_ELEMENTS, readFooterConfig, setPinned } from "../config/footer-config.js"
import type { FooterElementId } from "../config/footer-config.js"

interface FooterSettingsState {
	selectedIndex: number
	pinned: Set<FooterElementId>
	tui: {
		requestRender: (force?: boolean) => void
	}
}

class FooterSettingsComponent implements Component {
	private readonly theme: Theme
	private selectedIndex: number
	private readonly pinned: Set<FooterElementId>
	private readonly tui: { requestRender: (force?: boolean) => void }
	private readonly done: () => void

	constructor(state: FooterSettingsState, theme: Theme, done: () => void) {
		this.theme = theme
		this.selectedIndex = state.selectedIndex
		this.pinned = state.pinned
		this.tui = state.tui
		this.done = done
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return

		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1)
			this.tui.requestRender()
			return
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(FOOTER_ELEMENTS.length - 1, this.selectedIndex + 1)
			this.tui.requestRender()
			return
		}

		if (matchesKey(data, "space") || matchesKey(data, "return") || matchesKey(data, Key.enter)) {
			const el = FOOTER_ELEMENTS[this.selectedIndex]
			if (!el) return
			const nowPinned = !this.pinned.has(el.id)
			setPinned(el.id, nowPinned)
			if (nowPinned) {
				this.pinned.add(el.id)
			} else {
				this.pinned.delete(el.id)
			}
			this.tui.requestRender()
			return
		}

		if (matchesKey(data, Key.escape) || data === "q" || data === "x") {
			this.done()
			return
		}
	}

	render(width: number): string[] {
		const b = (s: string) => this.theme.fg("border", s)
		const accent = (s: string) => this.theme.fg("accent", s)
		const dimText = (s: string) => this.theme.fg("dim", s)
		const textColor = (s: string) => this.theme.fg("text", s)
		const mutedColor = (s: string) => this.theme.fg("muted", s)
		// Highlight selected row with accent color; fall back to accent for any theme.
		const selectedColor = (s: string) => accent(s)

		const innerW = Math.max(30, width - 2)
		const contentW = innerW - 2

		const out: string[] = []

		// ── top border with title ────────────────────────────────────────────
		const titleText = " Customize Footer "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		out.push(`${b(`╭${"─".repeat(leftB)}`)}${dimText(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		// ── header row ───────────────────────────────────────────────────────
		const headerText = `  ${dimText("PIN")}  ${dimText("ELEMENT")}  ${dimText("DESCRIPTION")}`
		const wrapRow = (rowContent: string) =>
			`${b("│")} ${rowContent}${" ".repeat(Math.max(0, contentW - visibleWidth(rowContent)))} ${b("│")}`
		out.push(wrapRow(headerText))
		out.push(b(`├${"─".repeat(innerW)}┤`))

		// ── element rows ─────────────────────────────────────────────────────
		const maxLabelW = Math.max(...FOOTER_ELEMENTS.map((e) => visibleWidth(e.label)))

		for (let i = 0; i < FOOTER_ELEMENTS.length; i++) {
			const el = FOOTER_ELEMENTS[i]
			const isSelected = i === this.selectedIndex
			const checked = this.pinned.has(el.id)

			const checkMark = checked ? accent("● ") : dimText("○ ")
			const labelRaw = el.label.padEnd(maxLabelW)
			const labelStyled = isSelected ? selectedColor(labelRaw) : textColor(labelRaw)
			const descStyled = isSelected ? dimText(el.description) : mutedColor(el.description)

			const prefix = isSelected ? `${accent("❯ ")}` : "  "
			const rowContent = `${prefix}${checkMark}${labelStyled}  ${descStyled}`

			out.push(wrapRow(rowContent))
		}

		// ── footer hint ──────────────────────────────────────────────────────
		out.push(b(`├${"─".repeat(innerW)}┤`))
		const hintText = "  Space / Enter to toggle  ·  ↑↓ to navigate  ·  Esc to close"
		out.push(wrapRow(dimText(hintText)))

		// ── bottom border ───────────────────────────────────────────────────
		out.push(b(`╰${"─".repeat(innerW)}╯`))

		return out
	}
}

export default function footerSettingsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("footer-settings", {
		description: "Customize which footer elements are pinned",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				// Fallback: print a simple text list for headless mode.
				const config = readFooterConfig()
				const pinned = new Set(config.pinned)
				const lines: string[] = ["Customize Footer — toggle pinning with Space/Enter"]
				for (const el of FOOTER_ELEMENTS) {
					const mark = pinned.has(el.id) ? "[●]" : "[○]"
					lines.push(`  ${mark} ${el.label}  —  ${el.description}`)
				}
				lines.push("")
				lines.push("Exit and re-run /footer-settings to update pins.")
				ctx.ui.notify(lines.join("\n"), "info")
				return
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const config = readFooterConfig()
					const state: FooterSettingsState = {
						selectedIndex: 0,
						pinned: new Set(config.pinned),
						tui: { requestRender: (force?: boolean) => tui.requestRender(force) },
					}
					return new FooterSettingsComponent(state, theme, done)
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "85%" } },
			)
		},
	})
}
