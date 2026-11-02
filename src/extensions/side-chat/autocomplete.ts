/**
 * Slash-command hints for the side chat editor.
 *
 * The side editor is a plain `CustomEditor`: unlike the main editor, nothing
 * sets an autocomplete provider on it. The main session's command list would
 * be wrong there anyway — only these commands are recognised by the side
 * chat's submit path (`handleSubmit` in `index.ts`); anything else is sent
 * to the side session's agent as prompt text, so hinting it would lie about
 * what runs.
 *
 * `/wrap` only runs in chat mode: in review mode every non-`/close` line is
 * the steering draft sent to the main session, and while a wrap-up draft is
 * streaming the editor is being overwritten.
 */

import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui"
import type { SidePanelMode } from "./panel.js"

const WRAP_COMMAND: SlashCommand = {
	name: "wrap",
	description: "Summarize this side chat into a steering prompt for the main session",
	argumentHint: "[extra instructions]",
}

const CLOSE_COMMAND: SlashCommand = {
	name: "close",
	description: "Close the side chat without sending anything",
}

/** The commands above are the single source of truth for what the side chat can run; the submit path parses with this. */
export type SideChatCommand = { name: "close" } | { name: "wrap"; args: string }

/**
 * Parse a submitted line as a side-chat command; anything else is prompt text
 * for the side session. `/close` matches the whole line exactly; `/wrap`
 * takes the rest of the line as extra instructions. Mode gating (e.g. `/wrap`
 * means plain draft text in review mode) stays with the caller — the hints
 * apply the same filter via {@link sideChatAutocomplete}.
 */
export function parseSideChatCommand(text: string): SideChatCommand | undefined {
	if (text === `/${CLOSE_COMMAND.name}`) return { name: "close" }
	const wrap = `/${WRAP_COMMAND.name}`
	if (text === wrap || text.startsWith(`${wrap} `)) {
		return { name: "wrap", args: text.slice(wrap.length).trim() }
	}
	return undefined
}

/** Autocomplete provider for the side editor, with only the commands runnable in `mode` (plus @ file completion). */
export function sideChatAutocomplete(mode: SidePanelMode, cwd: string): AutocompleteProvider {
	const commands: SlashCommand[] = mode === "chat" ? [WRAP_COMMAND, CLOSE_COMMAND] : [CLOSE_COMMAND]
	return new CombinedAutocompleteProvider(commands, cwd)
}
