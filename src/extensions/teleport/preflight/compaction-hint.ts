/**
 * Pure evaluator for the teleport pre-compact hint.
 *
 * High-level idea: when /teleport is about to upload a large session that was
 * recently active, compacting locally first is cheaper than letting the
 * remote re-read the full history cold (the local prompt cache is likely
 * still warm). For a stale session the economics flip — local compaction
 * would itself be a cold read — so liveness gates the hint on top of the
 * size threshold.
 *
 * Loop protection: suppress the hint when a compaction marker appears in the
 * session's recent tail (`compactionLookbackMessages`). Few messages since
 * the last compaction means compacting again would mostly re-keep what's
 * already there — re-hinting would just loop.
 *
 * The session JSONL is append-ordered, so the evaluator scans BACKWARD and
 * stops as soon as the suppression question is decided: at the first
 * compaction marker, once more than `compactionLookbackMessages` messages
 * have been counted without one, or at the start of the data. The caller
 * passes a tail slice of the file; if `tailIsWholeFile` is false and the
 * slice runs out before a stop condition, `decided` is false and the caller
 * should widen (e.g. re-read the whole file) and evaluate again.
 *
 * Sizing is the caller's job: the gate passes the harness's live context
 * usage (provider-backed). This evaluator only scans for liveness and
 * compaction markers — the hint is a non-critical nudge, so it is skipped
 * entirely when no live token count exists.
 */

/**
 * The hint's tuned parameters — implementation constants, deliberately NOT
 * user settings: tokenThreshold tracks the upload cost curve,
 * freshnessWindowMinutes tracks provider prompt-cache TTL, and
 * compactionLookbackMessages tracks compaction's keepRecentTokens (20K tokens
 * ≈ ~20 typical messages). The user's only knob is master on/off, read from
 * config and passed in via `enabled`.
 */
export interface TeleportCompactHintConfig {
	enabled: boolean
	/** Hint only fires above this session size (context tokens). */
	tokenThreshold: number
	/** Hint only fires when the session was active within this many minutes —
	 *  a proxy for "prompt cache plausibly still warm"; outside it, compaction
	 *  is itself cold and the economics invert. */
	freshnessWindowMinutes: number
	/** Suppress the hint when a compaction marker appears within the last N
	 *  messages — few messages since the last compaction means compacting
	 *  again would mostly re-keep what's already there. */
	compactionLookbackMessages: number
}

export const TELEPORT_COMPACT_HINT_DEFAULTS: TeleportCompactHintConfig = {
	enabled: true,
	tokenThreshold: 200_000,
	freshnessWindowMinutes: 60,
	compactionLookbackMessages: 20,
}

export interface CompactHintEvaluation {
	shouldHint: boolean
	/**
	 * False when the supplied tail ran out before either stop condition —
	 * suppression is unresolved and the caller should re-evaluate on a wider
	 * slice. shouldHint is always false in that case.
	 */
	decided: boolean
	/** The caller-supplied token count, echoed for message formatting. */
	estimatedTokens: number
	/** ms epoch of last session activity (newest timestamp seen while scanning back), if known. */
	lastActivityAt: number | undefined
	/** Message entries between the end of the tail and the most recent compaction marker (capped at the window + 1). */
	messagesSinceLastCompaction: number
}

export interface EvaluateCompactHintInput {
	/** A tail slice of the session JSONL (see tailIsWholeFile). May start mid-line; the first partial line is ignored internally. */
	sessionTail: string
	/** True when sessionTail covers the file from its start, making an exhausted scan's message count exact. */
	tailIsWholeFile: boolean
	/** Live token count for the session (e.g. ctx.getContextUsage().tokens). */
	estimatedTokens: number
	now: number
	config: TeleportCompactHintConfig
	/** Fallback timestamp (e.g. session file mtime) when no entry carries a parseable timestamp. */
	fallbackTimestampMs?: number
}

/** Parse a timestamp that may be ms epoch, seconds epoch (< 1e11), or a Date.parse-able string. */
function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e11 ? value * 1000 : value
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value)
		return Number.isNaN(parsed) ? undefined : parsed
	}
	return undefined
}

/** The pieces of a session-JSONL entry the hint cares about. */
interface ParsedEntry {
	/** ms epoch timestamp from entry.timestamp (or message.timestamp), if parseable. */
	timestampMs: number | undefined
	isCompaction: boolean
	isMessage: boolean
}

/** Parse one session-JSONL line into the fields the hint needs; undefined for malformed/non-object lines. */
function parseEntryLine(line: string): ParsedEntry | undefined {
	if (!line.trim()) return undefined
	let entry: unknown
	try {
		entry = JSON.parse(line)
	} catch {
		return undefined
	}
	if (entry === null || typeof entry !== "object") return undefined
	const record = entry as Record<string, unknown>

	const rawMessage =
		record.message !== null && typeof record.message === "object"
			? (record.message as Record<string, unknown>)
			: undefined
	const timestampMs =
		parseTimestamp(record.timestamp) ?? (rawMessage ? parseTimestamp(rawMessage.timestamp) : undefined)
	// A message entry is one that embeds a message object with a role — the unit
	// the lookback window counts (mirrors what compaction counts).
	const isMessage = rawMessage !== undefined && typeof rawMessage.role === "string"

	return { timestampMs, isCompaction: record.type === "compaction", isMessage }
}

export function evaluateCompactHint(input: EvaluateCompactHintInput): CompactHintEvaluation {
	const result = (
		decided: boolean,
		shouldHint: boolean,
		lastActivityAt: number | undefined,
		messagesSinceLastCompaction: number,
	): CompactHintEvaluation => ({
		decided,
		shouldHint: decided && shouldHint,
		estimatedTokens: input.estimatedTokens,
		lastActivityAt,
		messagesSinceLastCompaction,
	})

	const lines = input.sessionTail.split("\n")
	// A tail that doesn't start at offset 0 may begin mid-line; the first
	// fragment is not a complete entry, so skip it.
	let startIdx = 0
	if (!input.tailIsWholeFile) startIdx = 1

	let lastActivityAt: number | undefined
	let messagesSinceLastCompaction = 0
	const lookback = input.config.compactionLookbackMessages

	for (let i = lines.length - 1; i >= startIdx; i--) {
		const entry = parseEntryLine(lines[i])
		if (!entry) continue

		// The file is append-ordered, so the first parseable timestamp walking
		// back is the most recent activity — stop tracking after that.
		if (entry.timestampMs !== undefined && lastActivityAt === undefined) {
			lastActivityAt = entry.timestampMs
		}

		if (entry.isCompaction) {
			// Marker found with few messages after it → suppressed.
			return result(true, false, lastActivityAt, messagesSinceLastCompaction)
		}
		if (entry.isMessage) {
			messagesSinceLastCompaction++
			if (messagesSinceLastCompaction > lookback) {
				// Any compaction further back is older than the window → no
				// suppression; the count is a floor, not exact — enough.
				return evaluateUnsuppressed(lastActivityAt, messagesSinceLastCompaction)
			}
		}
	}
	// Tail exhausted before a stop condition: exact only if this was the whole
	// file (no compaction seen anywhere → count is every message).
	if (!input.tailIsWholeFile) {
		return result(false, false, lastActivityAt, messagesSinceLastCompaction)
	}

	return evaluateUnsuppressed(lastActivityAt, messagesSinceLastCompaction)

	// Reached only once recent-compaction suppression has been ruled out: apply
	// the remaining gates (enabled, threshold, liveness) and build the result.
	// Message count plays no role here — the backward scan above already
	// implements "few messages since the last compaction" via the marker, and
	// for a never-compacted session a low count must NOT suppress: big tool
	// results can push a handful of messages past the threshold, and
	// compaction keeps recent TOKENS, not recent messages, so it still helps.
	function evaluateUnsuppressed(activity: number | undefined, count: number): CompactHintEvaluation {
		const lastActivity = activity ?? input.fallbackTimestampMs
		const livenessWindowMs = input.config.freshnessWindowMinutes * 60_000
		const live = lastActivity !== undefined && input.now - lastActivity <= livenessWindowMs
		const shouldHint = input.config.enabled && input.estimatedTokens > input.config.tokenThreshold && live
		return result(true, shouldHint, lastActivity, count)
	}
}
