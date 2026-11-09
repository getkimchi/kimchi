/**
 * PII-redaction domain event channels published via pi.events.
 *
 * The pii-redaction extension emits these events; the telemetry extension
 * subscribes (telemetry/handlers/redactions.ts) and forwards them to OTLP.
 * This keeps the redaction hooks telemetry-free and makes every redaction
 * measurable in production.
 *
 * Privacy: payloads carry structured fields only — entity-type names from
 * the closed `[REDACTED-TYPE]` marker namespace, counts, the redacted
 * surface, and the worker shape. Never the original text, the matched
 * substring, match offsets, or the sensitive JSON key name — mirroring
 * the stance of loop-guard-events.ts / steer-events.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import type { RedactionReport } from "./redactor.js"

export const PII_REDACTION_EVENTS = {
	/** One event per (hook invocation × redacted entity type). */
	REDACTED: "pii_redaction:redacted",
	/** The engine scan threw and the text passed through unredacted (fail-open). */
	ENGINE_DEGRADED: "pii_redaction:engine_degraded",
} as const

export type PiiRedactionEventChannel = (typeof PII_REDACTION_EVENTS)[keyof typeof PII_REDACTION_EVENTS]

/** Which pipeline surface was scrubbed. */
export type RedactionSurface = "user_input" | "assistant_message" | "tool_result"

export interface PiiRedactedPayload {
	surface: RedactionSurface
	/**
	 * Entity type from the closed `[REDACTED-TYPE]` marker namespace
	 * (e.g. EMAIL_ADDRESS, PHONE_NUMBER, GITHUB_TOKEN, SECRET_FIELD).
	 * Never the matched text.
	 */
	entity_type: string
	/**
	 * The category the entity belongs to (e.g. emails, network) — the unit
	 * admins toggle. "custom" when the marker has no catalog attribution.
	 */
	category: string
	/** How many occurrences of entity_type were redacted in this invocation. */
	count: number
	/**
	 * Invocation-level denominator: strings scanned in this invocation
	 * (same value on every per-entity event of one invocation — consumers
	 * must not sum it across entities).
	 */
	strings_scanned: number
	/** True when the redaction happened inside an agent worker (subagent). */
	is_subagent: boolean
}

export interface PiiEngineDegradedPayload {
	surface: RedactionSurface
	/** Engine scans that failed (fail-open) in this invocation. */
	failures: number
	is_subagent: boolean
}

/** Env kill switch (repo precedent: KIMCHI_DISABLE_GUARD_* in steer-events.ts). */
export const KIMCHI_DISABLE_REDACTION_EVENTS = "KIMCHI_DISABLE_REDACTION_EVENTS"

/**
 * Publish the redaction facts of one hook invocation: one REDACTED event per
 * (invocation × entity type), plus ENGINE_DEGRADED when any scan failed
 * open. Counts come from the marker tally in `redactObjectStringsMeasured`,
 * which is privacy-safe by construction — markers are the only thing that
 * survives redaction.
 */
export function emitRedactionFacts(pi: ExtensionAPI, surface: RedactionSurface, report: RedactionReport): void {
	if (process.env[KIMCHI_DISABLE_REDACTION_EVENTS] === "1") return
	const isSubagent = isAgentWorker()
	for (const [entity_type, count] of Object.entries(report.entities)) {
		if (count <= 0) continue
		const payload: PiiRedactedPayload = {
			surface,
			entity_type,
			category: report.categories?.[entity_type] ?? "custom",
			count,
			strings_scanned: report.stringsScanned,
			is_subagent: isSubagent,
		}
		try {
			pi.events.emit(PII_REDACTION_EVENTS.REDACTED, payload)
		} catch {
			// pi.events may be unavailable on older hosts or lightweight test
			// mocks (precedent: bash-tool-guard / loop-guard emitters).
		}
	}
	if (report.engineFailures > 0) {
		const payload: PiiEngineDegradedPayload = { surface, failures: report.engineFailures, is_subagent: isSubagent }
		try {
			pi.events.emit(PII_REDACTION_EVENTS.ENGINE_DEGRADED, payload)
		} catch {
			// unavailable host/mock — redaction still functions without telemetry
		}
	}
}
