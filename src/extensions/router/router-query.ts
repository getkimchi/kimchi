import { getRedactionConfig } from "../pii-redaction/config.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"

export const ROUTER_IMAGE_METADATA = "[Routing metadata: the prompt contains images.]"

export type PrepareRouterQueryResult =
	| { ok: true; query: string }
	| { ok: false; reason: "empty_prompt" | "redaction_failed" }

export async function prepareRouterQuery(
	text: string,
	options: { containsImages?: boolean } = {},
): Promise<PrepareRouterQueryResult> {
	const containsImages = options.containsImages === true
	if (!text.trim() && !containsImages) return { ok: false, reason: "empty_prompt" }
	let redacted = text
	if (text.trim() && getRedactionConfig().enabled) {
		try {
			redacted = await redactTextOrThrow(text)
		} catch {
			return { ok: false, reason: "redaction_failed" }
		}
	}
	const query = containsImages
		? redacted.trim()
			? `${redacted.trimEnd()}\n\n${ROUTER_IMAGE_METADATA}`
			: ROUTER_IMAGE_METADATA
		: redacted
	return { ok: true, query }
}
