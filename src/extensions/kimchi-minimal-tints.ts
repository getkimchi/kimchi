// Apply per-process dynamic background tints for the `kimchi-minimal` theme.
//
// We mutate the loaded Theme's bgColors Map directly instead of writing tints
// into the on-disk theme file. Why: when kimchi runs simultaneously in two
// terminals (iTerm2 + Terminal.app), each instance would otherwise overwrite
// the shared file with its own terminal-bg-derived tints. Pi's theme watcher
// would then live-reload the OTHER instance's theme, showing tints derived
// from a different terminal's bg — visually wrong. Mutating in memory keeps
// each process's runtime state isolated.
//
// We get the live Theme via `ctx.ui.theme` at session_start. `theme.bgColors`
// and `theme.fgColors` return the underlying Maps; calling `.set(key, ansi)`
// is observed by every later `theme.bg(token, text)` / `theme.fg(token, text)`
// call from the rest of the app.
//
// Hex→ANSI conversion mirrors pi's internal bgAnsi/fgAnsi (theme.js): truecolor
// uses `48;2;R;G;B` / `38;2;R;G;B`, 256-color quantizes to the 6×6×6 cube +
// 24-step gray ramp.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getActiveThemeName, onThemeChange } from "../settings-watcher.js"
import {
	type Rgb,
	detectColorMode,
	estimateTerminalBackground,
	getProbedBackground,
	hexToBgAnsi,
	hexToFgAnsi,
	tintBackground,
} from "../terminal-bg-probe.js"
import { onThemeFileChange } from "../theme-file-watcher.js"

// In truecolor mode the deltas produce visually distinct steps. In 256-color
// mode (Terminal.app, screen) the 24-step gray ramp (step size 10) limits
// how many distinct levels are possible — very dark bgs may collapse pending
// and success onto the same ramp entry. The delta difference (6 vs 12) still
// helps on medium-dark bgs and guarantees distinction in truecolor.
const SURFACE_TINTS: ReadonlyArray<[token: string, delta: number, redBias: number]> = [
	["toolPendingBg", 6, 0],
	["toolSuccessBg", 12, 0],
	["toolErrorBg", 14, 10],
	["userMessageBg", 14, 0],
	["customMessageBg", 22, 0],
	["selectedBg", 30, 0],
]

// Foreground color tokens that need auto-contrast based on terminal bg luminance.
const ESSENTIAL_TEXT_TOKENS: readonly string[] = ["text"]

// Dark text for light backgrounds, light text for dark backgrounds.
// These are deliberately muted — not pure black/white — for visual comfort.
const DARK_TEXT_HEX = "#333333"
const LIGHT_TEXT_HEX = "#CCCCCC"

export default function kimchiMinimalTintsExtension(pi: ExtensionAPI) {
	const applyTints = (ctx: ExtensionContext) => {
		const baseBg: Rgb = getProbedBackground() ?? estimateTerminalBackground()
		const mode = detectColorMode()

		// ctx.ui.theme is the live Theme instance. Its `bgColors` and `fgColors`
		// are the underlying Maps; mutating them is observed by every later
		// `theme.bg(token, text)` / `theme.fg(token, text)` call. On theme switch
		// via /settings, pi creates a fresh Theme — we re-apply.
		const themeWithColors = ctx.ui.theme as unknown as {
			bgColors?: Map<string, string>
			fgColors?: Map<string, string>
		}
		if (!themeWithColors?.bgColors) return

		// Apply background tints.
		for (const [token, delta, redBias] of SURFACE_TINTS) {
			const hex = tintBackground(baseBg, delta, redBias, mode)
			themeWithColors.bgColors.set(token, hexToBgAnsi(hex, mode))
		}

		// Apply auto-contrast foreground colors based on terminal bg luminance.
		// Dark bgs (luminance < 128) get light text; light bgs get dark text.
		const luminance = 0.299 * baseBg.r + 0.587 * baseBg.g + 0.114 * baseBg.b
		const textHex = luminance < 128 ? LIGHT_TEXT_HEX : DARK_TEXT_HEX
		const fgAnsi = hexToFgAnsi(textHex, mode)

		if (themeWithColors.fgColors) {
			for (const token of ESSENTIAL_TEXT_TOKENS) {
				themeWithColors.fgColors.set(token, fgAnsi)
			}
		}
	}

	const triggerRerender = (ctx: ExtensionContext) => {
		// Nudge pi to repaint surfaces with the freshly-mutated colors.
		ctx.ui.setStatus("kimchi-tints-rerender", undefined)
	}

	let unsubscribeThemeChange: (() => void) | undefined
	let unsubscribeThemeFileChange: (() => void) | undefined

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (getActiveThemeName() === "kimchi-minimal") applyTints(ctx)

		unsubscribeThemeChange?.()
		unsubscribeThemeChange = onThemeChange((newName) => {
			if (newName === "kimchi-minimal") {
				applyTints(ctx)
				triggerRerender(ctx)
			}
		})

		// Re-apply tints when the active theme file is edited externally.
		unsubscribeThemeFileChange?.()
		unsubscribeThemeFileChange = onThemeFileChange((changedTheme) => {
			if (changedTheme === "kimchi-minimal") {
				applyTints(ctx)
				triggerRerender(ctx)
			}
		})
	})

	pi.on("session_shutdown", () => {
		unsubscribeThemeChange?.()
		unsubscribeThemeChange = undefined
		unsubscribeThemeFileChange?.()
		unsubscribeThemeFileChange = undefined
	})
}
