import { getRedactionConfig } from "../pii-redaction/config.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"

export type PrepareRouterQueryResult =
	| { ok: true; query: string }
	| { ok: false; reason: "empty_prompt" | "redaction_failed" }

export async function prepareRouterQuery(text: string): Promise<PrepareRouterQueryResult> {
	if (!text.trim()) return { ok: false, reason: "empty_prompt" }
	let redacted = text
	if (getRedactionConfig().enabled) {
		try {
			redacted = await redactTextOrThrow(text)
		} catch {
			return { ok: false, reason: "redaction_failed" }
		}
	}
	return { ok: true, query: redacted }
}
