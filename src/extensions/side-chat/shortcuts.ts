import { getKittyKeyboardSupport } from "../terminal-compat/keyboard-capability.js"

/**
 * Side chat key bindings, shared by the shortcut registration and the panel's hints.
 *
 * Focus uses ctrl+alt+arrows, not alt+digits: on macOS, Option+digit is
 * composed into a layout character (e.g. "Ń") unless the terminal sends
 * Option as Meta, while modified arrows always arrive as `ESC[1;7C/D`.
 * ctrl+digits are the feedback extension's response ratings.
 */
export const SIDE_CHAT_SHORTCUTS = {
	focusMain: "ctrl+alt+left",
	focusSide: "ctrl+alt+right",
} as const

/**
 * Compact hint for both focus keys, or undefined when the terminal can't
 * deliver them: without the Kitty keyboard protocol (the same check the
 * feedback extension applies to Ctrl+1) modified arrows may never arrive,
 * so the panel must not advertise keys that can't fire — clicking a pane
 * still focuses it.
 */
export function sideChatFocusHint(): string | undefined {
	return getKittyKeyboardSupport() === false ? undefined : "ctrl+alt+←/→"
}
