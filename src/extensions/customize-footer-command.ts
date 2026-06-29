import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { Key, isKeyRelease, matchesKey, visibleWidth } from "@earendil-works/pi-tui"
import { FOOTER_ELEMENTS, readFooterConfig, setPinned } from "../config/footer-config.js"
import { requestSharedFooterRender } from "./shared-footer.js"

/** Component holds only transient UI state (selectedIndex).
 *  Checked state is NEVER stored here — render() always reads from the config cache (always current). */
export class CustomizeFooterComponent implements Component {
	private selectedIndex: number
	private readonly tui: { requestRender: (force?: boolean) => void }
	private readonly done: () => void
	private readonly theme: Theme

	constructor(
		selectedIndex: number,
		tui: { requestRender: (force?: boolean) => void },
		done: () => void,
		theme: Theme,
	) {
		this.selectedIndex = selectedIndex
		this.tui = tui
		this.done = done
		this.theme = theme
	}

	invalidate(): void {
		// No-op: render() always reads from disk; no cache to invalidate.
	}

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
			// Cannot toggle permissions or model — they are always visible.
			if (el.canPin === false) return
			setPinned(el.id, !readFooterConfig().pinned.includes(el.id))
			this.tui.requestRender()
			requestSharedFooterRender()
			return
		}

		if (matchesKey(data, Key.escape) || data === "q" || data === "x") {
			this.done()
			return
		}
	}

	render(width: number): string[] {
		// Always reads from the config cache (always current; updated by every setPinned write).
		const pinned = new Set(readFooterConfig().pinned)

		const b = (s: string) => this.theme.fg("border", s)
		const accent = (s: string) => this.theme.fg("accent", s)
		const dimText = (s: string) => this.theme.fg("dim", s)
		const textColor = (s: string) => this.theme.fg("text", s)
		const mutedColor = (s: string) => this.theme.fg("muted", s)

		const innerW = Math.max(30, width - 2)
		const contentW = innerW - 2

		const wrapRow = (rowContent: string) =>
			`${b("│")} ${rowContent}${" ".repeat(Math.max(0, contentW - visibleWidth(rowContent)))} ${b("│")}`

		const out: string[] = []

		// ── top border with title ────────────────────────────────────────────
		const titleText = " Customize Footer "
		const borderLen = innerW - titleText.length
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		out.push(`${b(`╭${"─".repeat(leftB)}`)}${dimText(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		// ── header row ───────────────────────────────────────────────────────
		const maxLabelW = Math.max(...FOOTER_ELEMENTS.map((e) => visibleWidth(e.label)))
		out.push(wrapRow(`  ${dimText("● ")}${dimText("ELEMENT".padEnd(maxLabelW))}  ${dimText("DESCRIPTION")}`))
		out.push(b(`├${"─".repeat(innerW)}┤`))

		// ── element rows — always exactly 9 (FOOTER_ELEMENTS is a fixed constant) ──

		for (let i = 0; i < FOOTER_ELEMENTS.length; i++) {
			const el = FOOTER_ELEMENTS[i]
			const isSelected = i === this.selectedIndex
			const isNonPinnable = el.canPin === false

			const checkMark = isNonPinnable ? dimText("× ") : pinned.has(el.id) ? accent("● ") : dimText("○ ")

			const labelRaw = el.label.padEnd(maxLabelW)
			const labelStyled = isNonPinnable ? mutedColor(labelRaw) : isSelected ? accent(labelRaw) : textColor(labelRaw)
			const descStyled = isNonPinnable
				? dimText(el.description)
				: isSelected
					? dimText(el.description)
					: mutedColor(el.description)

			const prefix = isNonPinnable ? "  " : isSelected ? `${accent("❯ ")}` : "  "

			out.push(wrapRow(`${prefix}${checkMark}${labelStyled}  ${descStyled}`))
		}

		// ── footer hint ──────────────────────────────────────────────────────
		out.push(b(`├${"─".repeat(innerW)}┤`))
		out.push(wrapRow(dimText("  Space / Enter to toggle  ·  ↑↓ to navigate  ·  Esc to close")))

		// ── bottom border ───────────────────────────────────────────────────
		out.push(b(`╰${"─".repeat(innerW)}╯`))

		return out
	}
}

export default function customizeFooterExtension(pi: ExtensionAPI): void {
	pi.registerCommand("customize-footer", {
		description: "Customize which footer elements are pinned",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const pinned = new Set(readFooterConfig().pinned)
				const lines: string[] = ["Customize Footer"]
				for (const el of FOOTER_ELEMENTS) {
					const mark = el.canPin === false ? "[×]" : pinned.has(el.id) ? "[●]" : "[○]"
					lines.push(`  ${mark} ${el.label}  —  ${el.description}`)
				}
				ctx.ui.notify(lines.join("\n"), "info")
				return
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const firstInteractive = Math.max(
						0,
						FOOTER_ELEMENTS.findIndex((e) => e.canPin !== false),
					)
					return new CustomizeFooterComponent(
						firstInteractive,
						{ requestRender: (force) => tui.requestRender(force) },
						done,
						theme,
					)
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "85%" } },
			)
		},
	})
}
