import { getKittyKeyboardSupport } from "../terminal-compat/keyboard-capability.js"

// Terminals without the Kitty keyboard protocol can't send Ctrl+<digit>, so
// the feedback extension falls back to Ctrl+G / Ctrl+B there. Single source of
// truth for both the key handling and the advertised labels, so they can't
// drift apart.
//
// The probe is awaited in cli.ts before pi-mono's main() runs, so the result
// is settled before the first turn can end. It stays `undefined` only when the
// probe is skipped (non-TUI modes), where there is no keyboard to rate with.
export function usesLegacyRatingKeys(): boolean {
	return getKittyKeyboardSupport() === false
}

// Display labels for the rating shortcuts — advertise whichever pair works.
export function getRatingKeyLabels(): { good: string; bad: string } {
	if (usesLegacyRatingKeys()) return { good: "Ctrl+G", bad: "Ctrl+B" }
	return { good: "Ctrl+1", bad: "Ctrl+2" }
}
