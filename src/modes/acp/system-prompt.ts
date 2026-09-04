import { CAPABILITIES_KEY } from "./capabilities.js"

/** Minimal options shape needed by {@link resolveAcpAppendSystemPrompt}. */
export type AppendSystemPromptOptions = { appendSystemPrompt?: string[] }

/**
 * Extracts `_meta["kimchi.dev"].appendSystemPrompt` from an ACP request and
 * merges it with the `--append-system-prompt` CLI flag content (CLI flag first,
 * meta second) into the array DefaultResourceLoader appends to the composed
 * system prompt via the same appendSystemPrompt mechanism the CLI flag uses.
 *
 * The key is deliberately named `appendSystemPrompt` — matching the CLI flag
 * and the pi-mono resource-loader option — because the meta value is *appended*
 * to the composed system prompt, never replacing it. This keeps the plain
 * `systemPrompt` name free should a replace-the-system-prompt API ever be
 * exposed over `_meta`.
 *
 * Returns `undefined` when neither source contributes anything, so sessions
 * created without `_meta["kimchi.dev"].appendSystemPrompt` behave exactly as
 * before. The `_meta` namespace mirrors CAPABILITIES_KEY (`kimchi.dev`) — ACP
 * reserves `_meta` (additionalProperties: true) for custom data because
 * "Implementations MUST NOT add any custom fields at the root of a type".
 */
export function resolveAcpAppendSystemPrompt(
	params: { _meta?: unknown },
	options: AppendSystemPromptOptions,
): string[] | undefined {
	const kimchiMeta = (params._meta as Record<string, unknown> | null | undefined)?.[CAPABILITIES_KEY]
	const metaPrompt =
		typeof kimchiMeta === "object" && kimchiMeta !== null
			? (kimchiMeta as Record<string, unknown>).appendSystemPrompt
			: undefined
	const metaEntries = typeof metaPrompt === "string" && metaPrompt.trim() !== "" ? [metaPrompt] : []
	const combined = [...(options.appendSystemPrompt ?? []), ...metaEntries]
	return combined.length > 0 ? combined : undefined
}
