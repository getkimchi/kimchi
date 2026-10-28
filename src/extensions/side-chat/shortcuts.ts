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
	/** Compact hint for both focus keys. */
	focusHint: "ctrl+alt+←/→",
} as const
