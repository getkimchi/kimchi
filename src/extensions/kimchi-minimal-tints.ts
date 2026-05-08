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
// returns the underlying Map; calling `.set(key, ansi)` is observed by every
// later `theme.bg(token, text)` call from the rest of the app.
//
// Hex→ANSI conversion mirrors pi's internal bgAnsi (theme.js): truecolor uses
// `48;2;R;G;B`, 256-color quantizes to the 6×6×6 cube + 24-step gray ramp.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getActiveThemeName, onThemeChange } from "../settings-watcher.js"
import {
	type Rgb,
	detectColorMode,
	estimateTerminalBackground,
	getProbedBackground,
	hexToBgAnsi,
	tintBackground,
} from "../terminal-bg-probe.js"

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

export default function kimchiMinimalTintsExtension(pi: ExtensionAPI) {
	const applyTints = (ctx: ExtensionContext) => {
		const baseBg: Rgb = getProbedBackground() ?? estimateTerminalBackground()
		const mode = detectColorMode()

		// ctx.ui.theme is the live Theme instance. Its `bgColors` is the underlying
		// Map; mutating it is observed by every later `theme.bg(token, text)` call.
		// On theme switch via /settings, pi creates a fresh Theme — we re-apply.
		const themeWithBg = ctx.ui.theme as unknown as { bgColors?: Map<string, string> }
		if (!themeWithBg?.bgColors) return
		for (const [token, delta, redBias] of SURFACE_TINTS) {
			const hex = tintBackground(baseBg, delta, redBias, mode)
			themeWithBg.bgColors.set(token, hexToBgAnsi(hex, mode))
		}
	}

	let unsubscribeThemeChange: (() => void) | undefined

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (getActiveThemeName() === "kimchi-minimal") applyTints(ctx)

		unsubscribeThemeChange?.()
		unsubscribeThemeChange = onThemeChange((newName) => {
			if (newName === "kimchi-minimal") {
				applyTints(ctx)
				// Nudge pi to repaint surfaces with the freshly-mutated bgColors.
				ctx.ui.setStatus("kimchi-tints-rerender", undefined)
			}
		})
	})

	pi.on("session_shutdown", () => {
		unsubscribeThemeChange?.()
		unsubscribeThemeChange = undefined
	})
}
