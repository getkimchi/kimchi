import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { getKittyKeyboardSupport } from "./keyboard-capability.js"

interface TerminalWarningSettings {
	quietStartup?: boolean
	theme?: string
	lastTerminalWarnings?: Record<string, string>
}

// Check if a terminal warning should be shown based on nag control.
// Returns true if the warning should be shown, false if it was shown recently.
function shouldShowWarning(agentDir: string, terminalType: string): boolean {
	const settingsPath = resolve(agentDir, "settings.json")
	const today = new Date().toISOString().split("T")[0] // YYYY-MM-DD

	let settings: TerminalWarningSettings = {}
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"))
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = parsed as TerminalWarningSettings
			}
		} catch {
			// malformed; treat as no existing settings
		}
	}

	const lastWarnings = settings.lastTerminalWarnings ?? {}
	const lastShown = lastWarnings[terminalType]

	// Show if never shown or shown more than 24h ago
	if (!lastShown || lastShown < today) {
		// Update the last shown date
		settings.lastTerminalWarnings = { ...lastWarnings, [terminalType]: today }
		try {
			mkdirSync(dirname(settingsPath), { recursive: true })
			writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
		} catch {
			// best-effort; showing the warning is more important than persisting the date
		}
		return true
	}

	return false
}

// Emit a warning about terminal compatibility issues if detected.
// Call this before main() so the warning appears at startup.
export function emitTerminalCompatWarning(agentDir: string): void {
	if (!process.stdin.isTTY) return

	const isTmux = !!process.env.TMUX

	if (isTmux) {
		if (shouldShowWarning(agentDir, "tmux")) {
			console.warn(
				"⚠  kimchi: Shift+Enter may not work in tmux.\n" +
					"   Fix: add these to ~/.tmux.conf and restart tmux:\n" +
					"     set -g extended-keys on\n" +
					"     set -g extended-keys-format csi-u\n" +
					"   Alternative: use Ctrl+J to insert newlines.\n",
			)
		}
	}

	if (getKittyKeyboardSupport() === false) {
		if (shouldShowWarning(agentDir, "no_keyboard_protocol")) {
			console.warn(
				"⚠  kimchi: This terminal does not send modifier keys with Enter.\n" +
					"   Shift+Enter won't insert newlines.\n" +
					"   Alternative: use Ctrl+J to insert newlines.\n" +
					"   Recommend: switch to Ghostty, Kitty, iTerm2, or WezTerm.\n",
			)
		}
	}
}
