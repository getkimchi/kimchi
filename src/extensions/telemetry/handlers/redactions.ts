/**
 * Translates pii-redaction domain events (pii_redaction:redacted /
 * pii_redaction:engine_degraded) into OTLP log records.
 *
 * The pii-redaction extension publishes facts on the pi.events channels
 * defined in pii-redaction/redaction-events.ts; this handler forwards them
 * through the same attribute allowlist discipline as handlers/steers.ts — so
 * no original text, matched substrings, or JSON key names can leak, even if
 * a future payload field is added by mistake.
 *
 * Server contract (ai-optimizer): the record names below land in the
 * `kimchiEvent()` switch and become `kimchi.pii_redaction.*` metric rows.
 * Keep record names and attribute keys in one exported block so the
 * server-side transform can copy them verbatim.
 */
import type {
	PiiEngineDegradedPayload,
	PiiRedactedPayload,
	RedactionSurface,
} from "../../pii-redaction/redaction-events.js"
import type { TelemetryContext } from "../session-context.js"

/** OTLP record names (dot form; the server prefixes `kimchi.`). */
export const REDACTION_TELEMETRY_RECORDS = {
	REDACTED: "pii_redaction.redacted",
	SESSION_AFFECTED: "pii_redaction.session_affected",
	ENGINE_DEGRADED: "pii_redaction.engine_degraded",
} as const

/** Attribute keys this handler is allowed to emit (allowlist, steer-style). */
const REDACTED_ATTR_KEYS = ["surface", "entity_type", "count", "strings_scanned", "is_subagent"] as const
const ENGINE_DEGRADED_ATTR_KEYS = ["surface", "failures", "is_subagent"] as const
const SESSION_AFFECTED_ATTR_KEYS = ["is_subagent"] as const

/** Exported for handler tests and the server-side contract copy. */
export const REDACTION_TELEMETRY_ATTR_ALLOWLIST = {
	[REDACTION_TELEMETRY_RECORDS.REDACTED]: REDACTED_ATTR_KEYS,
	[REDACTION_TELEMETRY_RECORDS.ENGINE_DEGRADED]: ENGINE_DEGRADED_ATTR_KEYS,
	[REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED]: SESSION_AFFECTED_ATTR_KEYS,
} as const

function parseSurface(raw: unknown): RedactionSurface | undefined {
	return raw === "user_input" || raw === "assistant_message" || raw === "tool_result" ? raw : undefined
}

/**
 * Entity types are names from the `[REDACTED-<TYPE>]` marker namespace:
 * uppercase, underscore-separated. Validating the charset keeps arbitrary
 * payload text off the wire and bounds attribute cardinality.
 */
const ENTITY_TYPE_RE = /^[A-Z0-9_]+$/

function toPositiveInt(raw: unknown): number | undefined {
	return typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : undefined
}

/**
 * Per-session redaction handlers. The returned closures hold a
 * session_affected latch — one `pii_redaction.session_affected` record on
 * the first redaction of the session, mirroring MR 1037's
 * `guardrail.session.with_redactions` card. Each extension instance belongs
 * to one AgentSession, so the latch is naturally scoped to that session;
 * `reset()` re-arms it on session_start in case the host ever reuses one
 * extension instance for a second session in the same process.
 */
export function createRedactionHandlers() {
	let sessionAffectedEmitted = false
	return {
		/** Re-arm the per-session latch; telemetry/index.ts calls this on session_start. */
		reset(): void {
			sessionAffectedEmitted = false
		},
		onRedactionRedacted(ctx: TelemetryContext, raw: unknown): void {
			const payload = raw as Partial<PiiRedactedPayload> | null | undefined
			const surface = parseSurface(payload?.surface)
			const count = toPositiveInt(payload?.count)
			const stringsScanned =
				typeof payload?.strings_scanned === "number" &&
				Number.isInteger(payload.strings_scanned) &&
				payload.strings_scanned >= 0
					? payload.strings_scanned
					: 0
			if (
				!surface ||
				typeof payload?.entity_type !== "string" ||
				!ENTITY_TYPE_RE.test(payload.entity_type) ||
				count === undefined
			)
				return
			if (!sessionAffectedEmitted) {
				sessionAffectedEmitted = true
				ctx.emit(REDACTION_TELEMETRY_RECORDS.SESSION_AFFECTED, {
					is_subagent: payload.is_subagent === true,
				})
			}
			ctx.emit(REDACTION_TELEMETRY_RECORDS.REDACTED, {
				surface,
				entity_type: payload.entity_type,
				count,
				strings_scanned: stringsScanned,
				is_subagent: payload.is_subagent === true,
			})
		},
		onEngineDegraded(ctx: TelemetryContext, raw: unknown): void {
			const payload = raw as Partial<PiiEngineDegradedPayload> | null | undefined
			const surface = parseSurface(payload?.surface)
			const failures = toPositiveInt(payload?.failures)
			if (!surface || failures === undefined) return
			ctx.emit(REDACTION_TELEMETRY_RECORDS.ENGINE_DEGRADED, {
				surface,
				failures,
				is_subagent: payload?.is_subagent === true,
			})
		},
	}
}

export type RedactionHandlers = ReturnType<typeof createRedactionHandlers>
