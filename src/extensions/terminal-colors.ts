import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getActiveThemeName, onThemeChange } from "../settings-watcher.js"
import { QUERY_BG, getRawBgPayload } from "../terminal-bg-probe.js"

const FG_COLOR = "rgb:A1/A1/A1"
const BG_COLOR = "rgb:1A/18/18"
const SET_FG = `\x1b]10;${FG_COLOR}\x07`
const SET_BG = `\x1b]11;${BG_COLOR}\x07`
const QUERY_FG = "\x1b]10;?\x07"
const QUERY_TIMEOUT_MS = 200

// OSC 10/11 enforce kimchi's branded fg/bg over the terminal's own colors. Only
// applied when the user has opted into the rich `kimchi` theme. Any other theme
// (including kimchi-minimal, dark, light) lets the terminal own its bg/fg.
//
// OSC writes are sticky on the terminal, so when the user toggles themes via
// /settings we have to actively restore the saved fg/bg — otherwise the kimchi
// bg lingers under dark/light/kimchi-minimal.

export default function terminalColorsExtension(pi: ExtensionAPI) {
	let savedFg: string | null = null
	let savedBg: string | null = null
	let active = false
	let exitHandlersInstalled = false
	let lastCtx: ExtensionContext | undefined
	let unsubscribeThemeChange: (() => void) | undefined

	const restore = () => {
		if (!process.stdout.isTTY) return
		process.stdout.write(savedFg ? `\x1b]10;${savedFg}\x07` : "\x1b]110\x07")
		process.stdout.write(savedBg ? `\x1b]11;${savedBg}\x07` : "\x1b]111\x07")
		active = false
	}

	const apply = () => {
		if (!process.stdout.isTTY) return
		process.stdout.write(SET_FG)
		process.stdout.write(SET_BG)
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
		const wantActive = newName === "kimchi"
		if (wantActive && !active) apply()
		else if (!wantActive && active) restore()
		// Nudge pi to repaint chrome that may be stuck on stale bg.
		lastCtx?.ui.setStatus("kimchi-theme-rerender", undefined)
	}

	pi.on("session_start", (_event, ctx) => {
		if (!process.stdin.isTTY) return
		lastCtx = ctx
		installExitHandlers()

		// Probe & save terminal-original fg/bg unconditionally so we can restore
		// when the user later switches away from kimchi mid-session.
		probeAndSave(() => {
			if (getActiveThemeName() === "kimchi") apply()
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
