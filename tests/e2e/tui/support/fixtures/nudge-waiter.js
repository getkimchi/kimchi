/**
 * TUI e2e fixture extension for the continuation-nudge stop/wait tests.
 *
 * Loaded from the project-scope extensions dir
 * (`.config/kimchi/harness/extensions/`) that pi discovers automatically.
 * Registers a keyboard shortcut that injects an extension-sourced turn —
 * the same delivery path as a background-agent completion — with NO user
 * input event and NO tool call. Neither clears nudge-recovery pending state,
 * which is exactly what `continuation-nudge-stop-wait.test.ts` needs: after a
 * `<done>` acknowledgement it presses the shortcut and asserts the triggered
 * response streams visibly (stale recovery state used to blank it).
 *
 * Deliberately import-free so the binary's jiti loader needs no module
 * resolution beyond this file.
 */

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function nudgeWaiterExtension(pi) {
	// alt+q is not bound by any built-in or Kimchi extension keybinding, so
	// the shortcut always reaches this handler.
	pi.registerShortcut("alt+q", {
		description: "deliver a background-agent-style result",
		handler: () => {
			pi.sendMessage(
				{
					customType: "nudge-waiter-result",
					content: "The background watcher finished: build passed.",
					display: false,
				},
				{ triggerTurn: true },
			)
		},
	})
}
