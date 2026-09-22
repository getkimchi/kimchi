import { getKittyKeyboardSupport } from "../terminal-compat/keyboard-capability.js"

// Display labels for the rating shortcuts. Terminals without the Kitty
// keyboard protocol can't send Ctrl+<digit>, so the feedback extension falls
// back to Ctrl+G / Ctrl+B there — advertise whichever pair actually works.
export function getRatingKeyLabels(): { good: string; bad: string } {
	if (getKittyKeyboardSupport() === false) return { good: "Ctrl+G", bad: "Ctrl+B" }
	return { good: "Ctrl+1", bad: "Ctrl+2" }
}
