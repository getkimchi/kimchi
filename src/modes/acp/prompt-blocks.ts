/**
 * Text rendering for the prompt content blocks the ACP server hands the model.
 *
 * The ACP content spec (agentclientprotocol.com/protocol/v1/content) says
 * agents MUST support `resource_link` blocks in prompts — they are how a
 * client references a file the user @-mentioned (the model opens the URI
 * itself, so no `embeddedContext` capability is needed). Before this module,
 * `session/prompt` dropped them with a one-time stderr line, so an attached
 * file simply vanished from the conversation.
 *
 * Rendering follows the reference adapter (claude-agent-acp's
 * formatUriAsLink): `[@name](uri)`, padded with spaces so adjacent text
 * blocks never glue onto the bracket. Two deliberate divergences: every URI
 * scheme is linkified (the reference linkifies `file://` and `zed://` only),
 * and both fields are sanitized first — they are client-controlled and
 * `name` typically derives from a filesystem name, which may legally contain
 * brackets, parentheses and newlines; unsanitized interpolation would let a
 * hostile filename break out of the link and inject prompt text. Any URI that
 * URL-parses loses its userinfo before it reaches the model provider and the
 * persisted session history (credentials never help the model, whatever the
 * scheme); tokens in the query string are a documented residual (the model
 * needs the URI).
 */

import type { ContentBlock } from "@agentclientprotocol/sdk"

/** Control characters and the characters that would break out of the
 *  `[@name](uri)` markdown link. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this sanitizer
const NAME_BREAKOUT = /[[\]()\r\n\t]|[\x00-\x1f\x7f]/g

/** A string that cannot break out of the `[@name](uri)` link text. */
function sanitizeNameText(value: string): string {
	return value.replace(NAME_BREAKOUT, " ").replace(/\s+/g, " ").trim()
}

/** A display name that cannot break out of the markdown link text.
 *  `name` is `string | undefined` defensively: the wire schema requires it,
 *  but a missing name renders from the URI rather than crashing. The fallback
 *  segment is sanitized the same way — a basename can be entirely
 *  metacharacters too. */
function sanitizeName(name: string | undefined, uri: string): string {
	const cleaned = sanitizeNameText(name ?? "")
	if (cleaned.length > 0) return cleaned
	// Empty after sanitizing (or never set): fall back to the URI's last path
	// segment so the link still names something the model can open.
	const base = sanitizeNameText(uri.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "")
	return base.length > 0 ? base : "file"
}

/** A URI that cannot break out of the markdown link: control characters
 *  dropped (they are invalid in URIs), raw spaces and `)` percent-encoded so
 *  the target path is preserved but the link cannot be closed early. Any
 *  URL-parsable URI loses its userinfo (it never helps the model and would
 *  leak credentials to the provider and the session history, whatever the
 *  scheme); query-string tokens stay: the model needs the URI. */
function sanitizeUri(uri: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this sanitizer
	const stripped = uri.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]/g, "")
	const cleaned = stripped.replace(/[ )]/g, (c) => (c === " " ? "%20" : "%29"))
	try {
		const url = new URL(cleaned)
		if (url.username || url.password) {
			url.username = ""
			url.password = ""
			return url.toString()
		}
	} catch {
		// Not URL-parseable (zed:// and friends) — keep the control-stripped form.
	}
	return cleaned
}

/** The text this block contributes to the model prompt: text blocks verbatim,
 *  resource_link blocks as a space-padded markdown link, undefined for
 *  everything else (the caller drops those). */
export function promptBlockText(block: ContentBlock): string | undefined {
	if (block.type === "text") return block.text
	if (block.type !== "resource_link") return undefined
	// Defensive, mirroring the name fallback: the wire schema requires `uri`,
	// but a malformed block drops (with the caller's warning) instead of
	// throwing and failing the whole session/prompt turn.
	if (typeof block.uri !== "string") return undefined
	return ` [@${sanitizeName(block.name, block.uri)}](${sanitizeUri(block.uri)}) `
}
