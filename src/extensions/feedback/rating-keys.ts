import { getKittyKeyboardSupport } from "../terminal-compat/keyboard-capability.js"

// Terminals without the Kitty keyboard protocol can't send Ctrl+<digit>, so
// the feedback extension uses a single Ctrl+R "Rate response" picker there
// instead of the Ctrl+1/Ctrl+2 shortcuts. Single source of truth for both the
// key handling and the advertised labels, so they can't drift apart.
//
// The probe is awaited in cli.ts before pi-mono's main() runs, so the result
// is settled before the first turn can end. It stays `undefined` only when the
// probe is skipped (non-TUI modes), where there is no keyboard to rate with.
export function usesLegacyRatingPrompt(): boolean {
	return getKittyKeyboardSupport() === false
}

// Rating hint for the prompt summary — advertise whichever flow works.
export function getRatingSummaryHint(): string {
	if (usesLegacyRatingPrompt()) return "- Rate response: ▲▼ (Ctrl+R)"
	return "- Rate response: ⏶ Good (Ctrl+1)  ⏷ Bad (Ctrl+2)"
}

// Rating rows for the /help shortcut list.
export function getRatingHelpEntries(): { key: string; desc: string }[] {
	if (usesLegacyRatingPrompt()) return [{ key: "Ctrl+R", desc: "Rate response (Good/Bad picker)" }]
	return [
		{ key: "Ctrl+1", desc: "Rate response as Good" },
		{ key: "Ctrl+2", desc: "Rate response as Bad" },
	]
}
