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

/** Autocomplete provider for the side editor, with only the commands runnable in `mode` (plus @ file completion). */
export function sideChatAutocomplete(mode: SidePanelMode, cwd: string): AutocompleteProvider {
	const commands: SlashCommand[] = mode === "chat" ? [WRAP_COMMAND, CLOSE_COMMAND] : [CLOSE_COMMAND]
	return new CombinedAutocompleteProvider(commands, cwd)
}
