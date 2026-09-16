/**
 * Opens a patch file in the system's external viewer.
 *
 * The patch file is complete on disk BEFORE this runs. Editor selection:
 *  1. A known GUI/git editor from $GIT_EDITOR, $VISUAL, or $EDITOR (in that
 *     order — git's own precedence) when the binary basename is a recognized
 *     non-terminal editor (code, cursor, zed, subl, atom, fleet, emacs,
 *     gedit, textmate...). Terminal editors (vim/nano/…) are intentionally
 *     skipped: stealing the TUI's terminal mid-session corrupts the UI.
 *  2. Otherwise the OS default opener (macOS `open`, Linux `xdg-open`,
 *     Windows `start` via cmd), which launches whatever app the user has
 *     associated with .patch/.diff files.
 *
 * NEVER throws — the caller surfaces the manual path on failure.
 */

import { execFileSync } from "node:child_process"

/** non-terminal editor binary basenames we can spawn detached. */
const GUI_EDITORS = new Set([
	"code",
	"code-insiders",
	"cursor",
	"zed",
	"zeditor",
	"subl",
	"sublime",
	"atom",
	"fleet",
	"emacs",
	"emacsclient",
	"gedit",
	"mate",
	"codium",
	"bbedit",
	"webstorm",
	"idea",
])

export interface ExternalViewerResult {
	opened: boolean
	/** What was launched (command line, secrets-free) or why nothing was. */
	detail: string
}

/** First env var carrying a non-empty editor command, in git's precedence. */
function pickEditorEnv(env: NodeJS.ProcessEnv): string | undefined {
	for (const key of ["GIT_EDITOR", "VISUAL", "EDITOR"]) {
		const value = env[key]?.trim()
		if (value) return value
	}
	return undefined
}

/** Extract the binary basename from an editor command ("code --wait" → "code"). */
function editorBasename(command: string): string {
	const first = command.trim().split(/\s+/)[0] ?? ""
	const slash = first.replace(/\\/g, "/").lastIndexOf("/")
	return (slash === -1 ? first : first.slice(slash + 1)).toLowerCase()
}

export function openExternalDiff(
	patchPath: string,
	opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; _exec?: typeof execFileSync },
): ExternalViewerResult {
	const env = opts?.env ?? process.env
	const exec = opts?._exec ?? execFileSync

	const editorCommand = pickEditorEnv(env)
	if (editorCommand) {
		const binary = editorBasename(editorCommand)
		if (GUI_EDITORS.has(binary)) {
			try {
				// execFile with the whole editor command as argv[0] fails for
				// compounded commands like "code --wait" — split it.
				const [cmd, ...editorArgs] = editorCommand.trim().split(/\s+/)
				exec(cmd as string, [...editorArgs, patchPath], { stdio: "ignore" })
				return { opened: true, detail: `${editorCommand} ${patchPath}` }
			} catch (err) {
				return { opened: false, detail: `${editorCommand} failed: ${err instanceof Error ? err.message : String(err)}` }
			}
		}
		// Terminal editor set — do not hijack the TUI. Fall through to the OS
		// opener instead, which still gives the diff a real window.
	}

	const platform = opts?.platform ?? process.platform
	const [command, args] =
		platform === "darwin"
			? ["open", [patchPath]]
			: platform === "win32"
				? ["cmd", ["/c", "start", "", patchPath]]
				: ["xdg-open", [patchPath]]
	try {
		exec(command, args, { stdio: "ignore" })
		return { opened: true, detail: `${command} ${args.join(" ")}` }
	} catch (err) {
		return { opened: false, detail: `${command} failed: ${err instanceof Error ? err.message : String(err)}` }
	}
}
