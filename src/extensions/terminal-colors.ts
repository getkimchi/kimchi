import { readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getActiveThemeName, onThemeChange } from "../settings-watcher.js"
import { QUERY_BG, getRawBgPayload } from "../terminal-bg-probe.js"

const QUERY_FG = "\x1b]10;?\x07"
const QUERY_TIMEOUT_MS = 200

/** Converts hex color (#RRGGBB) to OSC rgb format (rgb:RR/GG/BB). */
function hexToOscRgb(hex: string): string | null {
	if (!hex || hex === "") return null
	// Convert #A1A1A1 to rgb:A1/A1/A1
	const match = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
	if (!match) return null
	const r = match[1].toUpperCase()
	const g = match[2].toUpperCase()
	const b = match[3].toUpperCase()
	return `rgb:${r}/${g}/${b}`
}

/** Detects iTerm2 specifically — only terminals that honour OSC 1337;SetColors. */
function isIterm2(): boolean {
	return process.env.TERM_PROGRAM === "iTerm.app"
}

/** Converts hex color (#RRGGBB) to iTerm2 OSC 1337 format (6-char hex without #). */
function hexToItermFormat(hex: string): string | null {
	if (!hex || hex === "") return null
	const match = hex.match(/^#?([0-9a-fA-F]{6})$/i)
	if (!match) return null
	return match[1].toUpperCase()
}

// OSC 10/11 enforce theme-specified fg/bg over the terminal's own colors.
// Applied when the user has opted into a theme that defines oscFg/oscBg.
// Any theme without these values (including kimchi-minimal) lets the terminal
// own its bg/fg.
//
// OSC writes are sticky on the terminal, so when the user toggles themes via
// /settings we have to actively restore the saved fg/bg — otherwise the
// theme bg lingers under another theme or kimchi-minimal.
//
// We never write raw space characters to stdout during an active session:
// pi-mono owns the terminal and is async — direct writes race with its render
// loop and produce corrupted escape sequences. The startup viewport fill is
// handled in cli.ts before pi-mono starts.

/** Returns raw hex colors (e.g. "#011627") for themes that opt into full-screen theming. */
function getThemeColors(themeName: string): { fgHex: string; bgHex: string } | null {
	try {
		const dir = process.env.KIMCHI_CODING_AGENT_DIR
		if (!dir) return null
		const path = resolve(dir, "themes", `${basename(themeName)}.json`)
		const raw = readFileSync(path, "utf-8")
		const theme = JSON.parse(raw)
		const vars: Record<string, string> = theme.vars ?? {}
		const resolveVar = (val: string): string => vars[val] ?? val

		const oscBgRaw: string = theme.colors?.oscBg ?? ""
		if (!oscBgRaw) return null
		const bgHex = resolveVar(oscBgRaw)
		if (!bgHex || !bgHex.startsWith("#")) return null

		const oscFgRaw: string = theme.colors?.oscFg ?? ""
		const fgHex = oscFgRaw ? resolveVar(oscFgRaw) : ""

		return { fgHex, bgHex }
	} catch {
		return null
	}
}

export default function terminalColorsExtension(pi: ExtensionAPI) {
	let savedFg: string | null = null
	let savedBg: string | null = null
	let active = false
	let exitHandlersInstalled = false
	let lastCtx: ExtensionContext | undefined
	let unsubscribeThemeChange: (() => void) | undefined
	// Shared by the onThemeChange callback and the sensor widget so neither
	// re-runs the OSC writes for a theme the other just handled.
	let lastSensorTheme: string | undefined

	const restore = () => {
		if (!process.stdout.isTTY) return

		if (isIterm2()) {
			// iTerm2: reset via named preset first, then fall back to saved OSC values
			process.stdout.write("\x1b]1337;SetColors=preset=Default\x07")
			process.stdout.write(savedFg ? `\x1b]10;${savedFg}\x07` : "\x1b]110\x07")
			process.stdout.write(savedBg ? `\x1b]11;${savedBg}\x07` : "\x1b]111\x07")
		} else {
			// Standard OSC reset (covers Terminal.app, Ghostty, Warp, etc.)
			process.stdout.write(savedFg ? `\x1b]10;${savedFg}\x07` : "\x1b]110\x07")
			process.stdout.write(savedBg ? `\x1b]11;${savedBg}\x07` : "\x1b]111\x07")
		}
		active = false
	}

	const apply = (fgHex: string, bgHex: string) => {
		if (!process.stdout.isTTY) return

		// OSC sequences change what "default background" means in the terminal emulator,
		// affecting future blank cells from scroll/resize. Pi-mono's own repaint covers
		// the TUI cells; OSC handles the rest.
		const oscFg = fgHex ? hexToOscRgb(fgHex) : null
		if (isIterm2()) {
			const itermBg = hexToItermFormat(bgHex)
			if (itermBg) process.stdout.write(`\x1b]1337;SetColors=bg=${itermBg}\x07`)
			if (oscFg) process.stdout.write(`\x1b]10;${oscFg}\x07`)
		} else {
			// Standard OSC 10/11 — Terminal.app, Ghostty, Warp, and most modern terminals
			const oscBg = hexToOscRgb(bgHex)
			if (oscFg) process.stdout.write(`\x1b]10;${oscFg}\x07`)
			if (oscBg) process.stdout.write(`\x1b]11;${oscBg}\x07`)
		}
		active = true
	}

	const installExitHandlers = () => {
		if (exitHandlersInstalled) return
		exitHandlersInstalled = true
		const onExit = () => {
			if (active) restore()
		}
		process.on("exit", onExit)
		const signalRestore = (signal: NodeJS.Signals) => {
			onExit()
			process.kill(process.pid, signal)
		}
		process.once("SIGINT", () => signalRestore("SIGINT"))
		process.once("SIGTERM", () => signalRestore("SIGTERM"))
		process.once("SIGHUP", () => signalRestore("SIGHUP"))
	}

	const probeAndSave = (then: () => void) => {
		// cli.ts already probed OSC 11 at startup and cached the raw payload —
		// reuse it instead of running a second probe. FG still needs probing.
		const cachedBg = getRawBgPayload()
		if (cachedBg) savedBg = cachedBg

		let buffer = ""
		let gotFg = false
		let gotBg = savedBg !== null
		const handler = (data: Buffer | string) => {
			buffer += data.toString()

			if (!gotFg) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminal escape sequence
				const fgMatch = buffer.match(/\x1b\]10;(.+?)(?:\x07|\x1b\\)/)
				if (fgMatch) {
					savedFg = fgMatch[1]
					gotFg = true
				}
			}
			if (!gotBg) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminal escape sequence
				const bgMatch = buffer.match(/\x1b\]11;(.+?)(?:\x07|\x1b\\)/)
				if (bgMatch) {
					savedBg = bgMatch[1]
					gotBg = true
				}
			}
			if (gotFg && gotBg) {
				cleanup()
				then()
			}
		}
		const cleanup = () => {
			process.stdin.removeListener("data", handler)
			clearTimeout(timeout)
			// Strip the OSC 10/11 responses from the buffer and push anything
			// else (keystrokes, paste) back to stdin so pi sees it.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminal escape sequence
			let leftover = buffer.replace(/\x1b\]10;.+?(?:\x07|\x1b\\)/, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminal escape sequence
			leftover = leftover.replace(/\x1b\]11;.+?(?:\x07|\x1b\\)/, "")
			if (leftover.length > 0) process.stdin.unshift(Buffer.from(leftover, "utf8"))
		}
		const timeout = setTimeout(() => {
			cleanup()
			then()
		}, QUERY_TIMEOUT_MS)

		process.stdin.on("data", handler)
		process.stdout.write(QUERY_FG)
		if (!gotBg) process.stdout.write(QUERY_BG)
	}

	const reactToThemeChange = (newName: string | undefined) => {
		// Mark before doing work — the setStatus call below invalidates the TUI,
		// which fires the sensor widget; without this update the sensor would
		// re-enter and emit duplicate OSC writes for the same theme.
		lastSensorTheme = newName
		const colors = getThemeColors(newName ?? "")

		if (colors?.bgHex) {
			apply(colors.fgHex, colors.bgHex)
		} else {
			if (active) restore()
		}
		// Nudge pi to repaint chrome that may be stuck on stale bg.
		lastCtx?.ui.setStatus("kimchi-theme-rerender", undefined)
	}

	pi.on("session_start", (_event, ctx) => {
		if (!process.stdin.isTTY) return
		lastCtx = ctx
		installExitHandlers()

		// Sensor widget: zero-height component whose invalidate() fires whenever
		// pi-mono calls TUI.invalidate() — which happens on every setTheme() call,
		// including live preview in /settings (onThemePreview doesn't write to disk,
		// so the file-watcher-based onThemeChange below won't catch it).
		// lastSensorTheme is factory-scoped and updated inside reactToThemeChange,
		// so the file-watcher path can't trigger a redundant invocation here.
		lastSensorTheme = ctx.ui.theme.name
		ctx.ui.setWidget("kimchi-osc-sensor", () => ({
			invalidate(): void {
				const name = ctx.ui.theme.name
				if (name !== undefined && name !== lastSensorTheme) {
					reactToThemeChange(name)
				}
			},
			render(): string[] {
				return []
			},
		}))

		// Probe & save terminal-original fg/bg unconditionally so we can restore
		// when the user later switches away from a theme that sets osc colors.
		// No clearScreen here — cli.ts paints the initial background before pi-mono
		// renders its first frame.
		probeAndSave(() => {
			const colors = getThemeColors(getActiveThemeName() ?? "")
			if (colors?.bgHex) apply(colors.fgHex, colors.bgHex)

			unsubscribeThemeChange?.()
			unsubscribeThemeChange = onThemeChange(reactToThemeChange)
		})
	})

	pi.on("session_shutdown", () => {
		if (active) restore()
		unsubscribeThemeChange?.()
		unsubscribeThemeChange = undefined
	})
}
