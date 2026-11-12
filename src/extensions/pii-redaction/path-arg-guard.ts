/**
 * Fail-closed guard for redaction placeholders in path-like tool arguments.
 *
 * message_end (and before_provider_request) redact every string of the
 * assistant message — tool-call arguments included — so a path that matched a
 * redaction pattern reaches file tools as the literal marker text, e.g.
 * `[REDACTED-LOCAL_PATH]`. File tools treat that as a relative file name:
 * a write silently lands in a file named after the marker in the cwd while
 * the UI still shows the original path. The guard refuses such calls before
 * execution; the agent gets the error instead of a wrong write.
 *
 * Scope is deliberately narrow — the argument KEY decides, never the value:
 * only keys that name a filesystem path (`path`, `file_path`, `filePath`) are
 * inspected, for every tool including MCP and nested codemode calls (they all
 * fire the same `tool_call` event). Free-text keys (`content`, `code`,
 * `command`, `pattern`, …) are never inspected: writing tests or docs that
 * contain `[REDACTED-…]` markers must keep working — this extension's own
 * tests do exactly that. The guard refuses calls; it never rewrites, un-does,
 * or otherwise weakens a redaction.
 *
 * Residual risk (accepted): only top-level string values under the three
 * path keys are inspected. MCP shapes that name paths differently —
 * `source`/`destination` keys, a `paths[]` array, or nested objects like
 * `{ edits: [{ path }] }` — pass through uncovered, and a bash `command`
 * string containing a placeholder is never inspected (the `command`
 * exclusion is spec-mandated: free text must stay untouched). A placeholder
 * that slips through these gaps degrades to the pre-guard behavior — a
 * possible wrong write — and never to a weaker redaction.
 */

/**
 * Marker shape the redactor's custom patterns and engine composition emit:
 * `[REDACTED-<ENTITY>]` (`[REDACTED-LOCAL_PATH]`, `[REDACTED-SECRET_FIELD]`,
 * …). Not anchored to the whole value — a placeholder can be one segment of
 * a longer path (`src/[REDACTED-LOCAL_PATH]/x`).
 */
const REDACTION_MARKER_RE = /\[REDACTED-[A-Z0-9_]+\]/

/**
 * Argument keys that name a filesystem path across the read/write/edit/
 * ls/find/grep family and common MCP tool shapes (Claude-style `file_path`).
 * Keyed by exact key name — the one judgment this module makes.
 */
const PATH_ARG_KEYS: readonly string[] = ["path", "file_path", "filePath"]

/** What the guard found in a tool call's path-like argument. */
export interface PathArgPlaceholder {
	/** The offending argument key. */
	key: string
	/** The first marker found in it. */
	marker: string
}

/**
 * Whether a path-like argument of a tool call carries a redaction
 * placeholder. Returns the first finding (key + marker), or undefined when
 * every path-like argument is marker-free, absent, or not a string. Pure and
 * total: any input shape is safe to hand it.
 */
export function findPathArgPlaceholder(input: unknown): PathArgPlaceholder | undefined {
	if (input === null || typeof input !== "object") return undefined
	const record = input as Record<PropertyKey, unknown>
	for (const key of PATH_ARG_KEYS) {
		const value = record[key]
		if (typeof value !== "string") continue
		const marker = REDACTION_MARKER_RE.exec(value)?.[0]
		if (marker !== undefined) return { key, marker }
	}
	return undefined
}

/** The block reason the agent sees — names the argument and the placeholder. */
export function pathArgPlaceholderReason(finding: PathArgPlaceholder, toolName: string): string {
	return (
		`The "${finding.key}" argument of the ${toolName} tool contains the redaction ` +
		`placeholder ${finding.marker}. The original value was redacted before this call ` +
		"and is not available to the agent. Ask the user for the path, or build a path " +
		"that does not rely on redacted content."
	)
}
