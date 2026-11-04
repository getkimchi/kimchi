import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"
import { escapeClosingMarker, markHarnessSteer } from "../steer-marker.js"
import { LANGUAGE_HINT_CUSTOM_TYPE, pinnedLanguageTurnHint } from "./system-prompt.js"

type Message = OrchestratorMessages[number]

function isLanguageHint(m: Message): boolean {
	return (
		m.role === "custom" && "customType" in m && (m as { customType?: string }).customType === LANGUAGE_HINT_CUSTOM_TYPE
	)
}

/**
 * Per-request language reminder for the pinned case, applied at the `context`
 * boundary and never persisted.
 *
 * Why here and not as a `before_agent_start` message: pi persists those as
 * session custom messages, so a 30-turn session pinned to Korean would carry
 * 30 "Reply in Korean" user-role messages — and keep carrying them after
 * `/language fr` or `/language auto`, reproducing the very drift the pin is
 * meant to stop. Injecting at context time means exactly one copy, always
 * stating the *current* pin, placed right after the latest user message (the
 * spot weak models actually attend to), stable across every request of the
 * same turn so the in-turn cache prefix holds.
 *
 * Also strips any `language_hint` custom messages that an earlier build
 * persisted into the session, so old sessions self-heal.
 */
export function applyLanguageHint(messages: OrchestratorMessages, language: string | undefined): OrchestratorMessages {
	const stripped = messages.filter((m) => !isLanguageHint(m))
	if (language === undefined) {
		return stripped.length === messages.length ? messages : stripped
	}
	const lastUserIdx = stripped.findLastIndex((m) => m.role === "user")
	if (lastUserIdx === -1) return stripped
	const hint = {
		role: "custom",
		customType: LANGUAGE_HINT_CUSTOM_TYPE,
		// The value is user/config text: a literal "</system-reminder>" passes
		// normalizeLanguageSetting, so neutralise it before wrapping.
		content: [{ type: "text", text: markHarnessSteer(escapeClosingMarker(pinnedLanguageTurnHint(language))) }],
		display: false,
		timestamp: stripped[lastUserIdx].timestamp,
	} as unknown as Message
	return [...stripped.slice(0, lastUserIdx + 1), hint, ...stripped.slice(lastUserIdx + 1)]
}
