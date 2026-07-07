/**
 * PII redactor built on @bulkhead-ai/core.
 *
 * Scans text content in pi-ai messages for PII (emails, phones, SSNs, credit
 * cards via Luhn, IBANs via mod-97) and secrets (API keys, Bearer tokens, AWS
 * keys, GitHub tokens) using regex-based guards. Matches are replaced with
 * `[REDACTED-TYPE]` markers (e.g. `[REDACTED-EMAIL_ADDRESS]`,
 * `[REDACTED-CREDIT_CARD]`, `[REDACTED-GITHUB_TOKEN]`).
 *
 * The engine is lazily initialized — `createEngine()` instantiates guard
 * objects with compiled regex patterns, which is cheap. The cached instance is
 * stateless (no per-session data) so it does not leak across sessions or tests.
 * `resetRedactorEngine()` is exported for test isolation.
 */

import { type BulkheadConfig, DEFAULT_CONFIG, type GuardrailsEngine, createEngine } from "@bulkhead-ai/core"

let engine: GuardrailsEngine | undefined

/**
 * Get or create the singleton redaction engine.
 *
 * PiiGuard covers emails, phones, SSNs, credit cards (Luhn), IBANs (mod-97).
 * SecretGuard covers API keys, Bearer tokens, AWS keys, GitHub tokens.
 * Injection and content-safety guards are disabled — not relevant to PII
 * scrubbing.
 */
function getEngine(): GuardrailsEngine {
	if (engine) return engine
	const config: BulkheadConfig = {
		...DEFAULT_CONFIG,
		enabled: true,
		guards: {
			pii: { enabled: true },
			secret: { enabled: true },
			injection: { enabled: false },
			contentSafety: { enabled: false },
		},
	}
	engine = createEngine(config)
	// Exclude GUIDs from redaction — they are structural identifiers
	// (ferment IDs, session IDs), not sensitive PII. Redacting them breaks
	// internal flows that depend on UUIDs being present in context.
	engine.setExcludeEntities(["GUID"])
	return engine
}

/** Reset the cached engine — for test isolation. */
export function resetRedactorEngine(): void {
	engine = undefined
}

/**
 * Scan a single string for PII/secrets and return the redacted version.
 *
 * If scanning fails (engine error, unexpected input), the original text is
 * returned unchanged — redaction must never break the prompt pipeline.
 * The error is logged per the code-review-lessons rule: no empty catch blocks.
 */
export async function redactText(text: string): Promise<string> {
	try {
		const result = await getEngine().scan(text)
		return result.redactedText ?? text
	} catch (err) {
		console.error("PII redaction scan failed, returning original text:", err)
		return text
	}
}

/**
 * Deep-walk any JSON-serializable structure and redact all string values.
 *
 * Unlike `redactMessages`, which only scans `type:"text"` content blocks,
 * this function walks **every** string in the object tree — including
 * tool-call arguments, tool results, metadata fields, etc. This is the
 * right tool for export transcripts where secrets can appear anywhere.
 *
 * Returns a **new** structure; the input is never mutated.
 *
 * @param obj  Any JSON-serializable value (object, array, primitive)
 * @returns     Deep clone with all string values redacted
 */
export async function redactObjectStrings<T>(obj: T): Promise<T> {
	if (typeof obj === "string") {
		return (await redactText(obj)) as T
	}
	if (Array.isArray(obj)) {
		return Promise.all(obj.map((item) => redactObjectStrings(item))) as Promise<T>
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			result[key] = await redactObjectStrings(value)
		}
		return result as T
	}
	return obj
}

/** A pi-ai text content block — the only block type we redact. */
interface TextBlock {
	type: "text"
	text: string
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		block !== null &&
		typeof block === "object" &&
		(block as Record<string, unknown>).type === "text" &&
		typeof (block as Record<string, unknown>).text === "string"
	)
}

interface AnyMessage {
	role?: string
	content?: unknown
}

/**
 * Redact PII and secrets from a pi-ai message array.
 *
 * Deep-walks every message — including tool-call arguments, tool-result
 * content, and any other string fields — replacing matched PII/secret
 * spans with `[REDACTED-TYPE]` markers. Returns a **new** array; the
 * input is never mutated.
 *
 * System messages (role: "system") are skipped — the system prompt
 * contains structural identifiers (ferment IDs, session IDs, paths) that
 * must not be redacted, and its content is harness-generated, not
 * user-provided PII.
 *
 * Structural strings (role, type, toolCallId, toolName) pass through
 * unchanged because they don't match PII/secret patterns.
 *
 * @param messages  pi-ai `Message[]` (the output of `convertToLlm`)
 * @returns          New array with all string values redacted; input untouched
 */
export async function redactMessages(messages: unknown[]): Promise<unknown[]> {
	return Promise.all(
		messages.map(async (msg) => {
			if (msg === null || typeof msg !== "object") return msg
			const message = msg as AnyMessage
			// Skip system messages — they contain structural identifiers
			// (ferment IDs, session IDs) that must not be redacted.
			if (message.role === "system") return msg
			return redactObjectStrings(msg)
		}),
	)
}
