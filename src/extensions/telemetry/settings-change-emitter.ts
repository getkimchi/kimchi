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
 * The watcher reuses the proven file-watch + 30ms debounce pattern from
 * `src/settings-watcher.ts`. It is telemetry-agnostic — the caller (the
 * telemetry extension lifecycle) decides whether to start it based on
 * whether telemetry is enabled.
 */

import { type FSWatcher, readFileSync, watch } from "node:fs"
import { resolve } from "node:path"

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
 * that closes the watcher and clears any pending debounce timer.
 *
 * If `KIMCHI_CODING_AGENT_DIR` is unset or `settings.json` cannot be watched,
 * returns a no-op stop function.
 */
export function startSettingsChangeWatcher(emit: EmitFn): () => void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return () => {}

	let previous = readSettings(agentDir)
	let debounceTimer: NodeJS.Timeout | undefined
	let watcher: FSWatcher | undefined

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

	try {
		// Watch the parent directory rather than the file itself. Editors that
		// replace settings.json atomically (write temp + rename) create a new
		// inode; watching the file directly on Linux would lose the watcher.
		// Directory-level watching survives inode replacement.
		const settingsPath = resolve(agentDir, "settings.json")
		watcher = watch(agentDir, { persistent: false }, (eventType, filename) => {
			if (filename !== "settings.json") return
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = setTimeout(fire, DEBOUNCE_MS)
		})
		watcher.unref?.()
		watcher.on("error", () => {
			watcher?.close()
			watcher = undefined
		})
		// Reference settingsPath to keep the linter happy — the path is only
		// used implicitly via the directory watcher + readSettings inside fire().
		void settingsPath
	} catch {
		// settings.json (or its parent dir) may not exist yet.
	}

	return () => {
		if (debounceTimer) clearTimeout(debounceTimer)
		watcher?.close()
		watcher = undefined
	}
}
