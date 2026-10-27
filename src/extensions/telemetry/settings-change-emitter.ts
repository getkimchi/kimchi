/**
 * Settings-change emitter for the `config_changed` telemetry event.
 *
 * Watches pi's `settings.json` (in `KIMCHI_CODING_AGENT_DIR`) for writes —
 * the same file the `/settings` UI updates. On each debounced change, diffs
 * the previous top-level keys against the new ones and emits one
 * `config_changed` event per changed key via the caller-supplied `emit`
 * function (typically `SessionContext.emit`).
 *
 * Values are redacted to category-level representations so no secret or PII
 * can leak: booleans/numbers pass through; strings are checked for URL /
 * email / token patterns; objects/arrays/null are never emitted verbatim.
 *
 * Change detection is stat polling (`watchFile`); the 30ms debounce pattern
 * comes from `src/settings-watcher.ts`. The emitter is telemetry-agnostic —
 * the caller (the telemetry extension lifecycle) decides whether to start
 * it based on whether telemetry is enabled.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type StatPoller, startStatPoller } from "../../shared/stat-poller.js"

/** Caller-supplied emit function (matches `SessionContext.emit`'s shape). */
export type EmitFn = (event: string, properties: Record<string, string | number | boolean>) => void

const DEBOUNCE_MS = 30

/**
 * Redact a settings value to a safe category-level representation.
 *
 * - booleans/numbers are returned as-is (cannot carry PII)
 * - strings are checked for URL/email/secret patterns; safe config
 *   identifiers (theme name, model id) pass through unchanged
 * - objects/arrays/null are never emitted verbatim (may contain nested
 *   secrets) — represented as `"redacted:object"`
 */
export function redactValue(key: string, value: unknown): string | number | boolean {
	if (typeof value === "boolean" || typeof value === "number") return value
	if (typeof value === "string") {
		if (/^https?:\/\//i.test(value)) return "redacted:url"
		if (/^\S+@\S+\.\S+$/.test(value)) return "redacted:email"
		if (/(key|token|secret|password|apikey|credential)/i.test(key)) return "redacted:secret"
		// Token-like strings with known prefixes (sk-, pk-, Bearer , etc.)
		// are almost certainly API keys or auth tokens.
		if (/^(sk-|pk[-_]|bearer\s|gh[ps]_|xox[bap]-)/i.test(value)) return "redacted:secret"
		return value
	}
	return "redacted:object"
}

function readSettings(agentDir: string): Record<string, unknown> | undefined {
	try {
		const raw = readFileSync(resolve(agentDir, "settings.json"), "utf-8")
		const parsed: unknown = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return undefined
	} catch {
		return undefined
	}
}

/**
 * Start watching `settings.json` for changes. On each debounced change, diff
 * the previous top-level keys against the new ones and emit a
 * `config_changed` event per changed key via `emit`. Returns a stop function
 * that stops polling and clears any pending debounce timer.
 *
 * Change detection is stat polling at 250ms, so writes land at most that
 * long plus the debounce after they happen. Polling is path-based, so it
 * survives atomic replacement, and it never holds a directory watch on the
 * agent dir — on macOS such a watch is a recursive FSEvents subscription to
 * the whole harness tree, which every kimchi process writes constantly.
 *
 * If `KIMCHI_CODING_AGENT_DIR` is unset or `settings.json` cannot be watched,
 * returns a no-op stop function.
 */
export function startSettingsChangeWatcher(emit: EmitFn): () => void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return () => {}

	let previous = readSettings(agentDir)
	let debounceTimer: NodeJS.Timeout | undefined
	const settingsPath = resolve(agentDir, "settings.json")
	let poller: StatPoller | undefined
	let stopped = false

	const fire = (): void => {
		debounceTimer = undefined
		const current = readSettings(agentDir)
		if (!current) return
		const prev = previous ?? {}
		const allKeys = new Set([...Object.keys(prev), ...Object.keys(current)])
		for (const key of allKeys) {
			// Deep-equality check via JSON stringify handles primitives and
			// nested structures uniformly.
			if (JSON.stringify(prev[key]) === JSON.stringify(current[key])) continue
			emit("config_changed", {
				key,
				value: redactValue(key, current[key]),
			})
		}
		previous = current
	}

	const scheduleFire = (): void => {
		if (stopped) return
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(fire, DEBOUNCE_MS)
	}

	try {
		// Stat polling observes writes during attachment and atomic
		// replacement alike; snapshot comparison prevents duplicate events.
		poller = startStatPoller(settingsPath, 250, scheduleFire)
	} catch {
		// Telemetry remains best-effort if polling cannot be started.
	}

	return () => {
		stopped = true
		if (debounceTimer) clearTimeout(debounceTimer)
		poller?.stop()
		poller = undefined
	}
}
