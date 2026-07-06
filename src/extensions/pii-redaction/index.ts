/**
 * PII redaction extension.
 *
 * Registers a `before_provider_request` handler that scrubs PII (emails,
 * phones, SSNs, credit cards, IBANs) and secrets (API keys, Bearer tokens,
 * AWS keys, GitHub tokens) from outgoing provider-request messages using
 * @bulkhead-ai/core.
 *
 * Contract: the `before_provider_request` event is emitted by pi-mono's
 * ExtensionRunner.emitBeforeProviderRequest. Handlers receive `event.payload`
 * with `payload.messages` as pi-ai `Message[]` (the output of convertToLlm).
 * Returning a modified payload replaces it. See orphan-tool-result-sanitizer.ts
 * for the same pattern.
 *
 * Redaction is enabled by default. Disable via:
 *   - KIMCHI_REDACTION_ENABLED=0 env var
 *   - config.json { "redaction": { "enabled": false } }
 *
 * The handler is async — @bulkhead-ai/core's engine.scan() returns a Promise.
 * pi-mono's ExtensionRunner awaits handler return values when they are
 * Promises, so the async redaction completes before the request is sent.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { getRedactionConfig } from "./config.js"
import { redactMessages } from "./redactor.js"

const piiRedactionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", async (event: unknown) => {
		const payload = (event as Record<string, unknown> | null)?.payload as Record<string, unknown> | null
		if (!payload || typeof payload !== "object") return

		const messages = payload.messages
		if (!Array.isArray(messages)) return

		// Redaction config is cached at startup — avoids sync disk I/O in the hot path.
		const config = getRedactionConfig()
		if (!config.enabled) return

		// Redact PII/secrets from all text content in the messages.
		// redactMessages returns a new array; input is never mutated.
		const redacted = await redactMessages(messages)
		payload.messages = redacted
		return payload
	})
}

export default piiRedactionExtension
