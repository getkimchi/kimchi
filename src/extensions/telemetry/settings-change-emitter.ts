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
 * The watcher watches `settings.json` directly (the proven pattern from
 * `src/settings-watcher.ts`), with an mtime+size signature gate against
 * spurious kqueue events and a 2s guard interval that re-arms the watch and
 * catches atomic-rename replacement. It is telemetry-agnostic — the caller
 * (the telemetry extension lifecycle) decides whether to start it based on
 * whether telemetry is enabled.
 */

import { type FSWatcher, readFileSync, watch } from "node:fs"
import { resolve } from "node:path"

import { fileSignature } from "../../config/json.js"

/** Caller-supplied emit function (matches `SessionContext.emit`'s shape). */
export type EmitFn = (event: string, properties: Record<string, string | number | boolean>) => void

const DEBOUNCE_MS = 30
/**
 * Safety-net poll interval: re-arms a failed/died watch, and catches atomic
 * settings.json replacement (write temp + rename) that a file-level watch can
 * miss on Linux. Cost is one statSync per tick — negligible.
 */
const GUARD_INTERVAL_MS = 2000

/** Optional tuning knobs. Only tests pass these; production uses the defaults. */
export interface SettingsWatcherOptions {
	debounceMs?: number
	guardIntervalMs?: number
}

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

function readSettings(settingsPath: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"))
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return undefined
	} catch {
		return undefined
	}
}

/**
 * Start watching `settings.json` (the file itself, not its directory) for
 * changes. On each debounced change, diff the previous top-level keys against
 * the new ones and emit a `config_changed` event per changed key via `emit`.
 * Returns a stop function that closes the watcher and clears all timers.
 *
 * A file-level watch is deliberate: watching the agent directory was measured
 * at 1.9s to register and 9.3s to close in Bun when the directory contains many
 * files (skills/, sessions/). The proven twin `src/settings-watcher.ts` watches
 * the file directly with the same mtime+size signature gate used here to drop
 * spurious kqueue events on unchanged files.
 *
 * If `KIMCHI_CODING_AGENT_DIR` is unset, returns a no-op stop function.
 */
export function startSettingsChangeWatcher(emit: EmitFn, options: SettingsWatcherOptions = {}): () => void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return () => {}

	const settingsPath = resolve(agentDir, "settings.json")
	const debounceMs = options.debounceMs ?? DEBOUNCE_MS
	const guardIntervalMs = options.guardIntervalMs ?? GUARD_INTERVAL_MS

	let previous = readSettings(settingsPath)
	let lastSignature = fileSignature(settingsPath)
	let debounceTimer: NodeJS.Timeout | undefined
	let guardTimer: NodeJS.Timeout | undefined
	let watcher: FSWatcher | undefined
	let stopped = false

	const fire = (): void => {
		debounceTimer = undefined
		// Drop spurious fs.watch events on an unchanged file (macOS/bun kqueue
		// quirk documented in src/settings-watcher.ts) before doing any work.
		const sig = fileSignature(settingsPath)
		if (sig !== undefined && sig === lastSignature) return
		const current = readSettings(settingsPath)
		if (!current) return
		lastSignature = sig ?? lastSignature
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
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(fire, debounceMs)
		// Never let the debounce window keep a finished process alive.
		debounceTimer.unref?.()
	}

	const arm = (): void => {
		if (watcher || stopped) return
		try {
			// Watch the FILE, not its directory. Directory-level watching was
			// adopted to survive editors that atomically replace settings.json
			// (new inode); the guard interval below provides that survival
			// instead, without scanning the whole agent dir.
			const w = watch(settingsPath, { persistent: false }, scheduleFire)
			w.unref?.()
			w.on("error", () => {
				try {
					w.close()
				} catch {
					// Watcher already destroyed.
				}
				if (watcher === w) watcher = undefined
			})
			watcher = w
		} catch {
			// settings.json may not exist yet — the guard interval re-arms.
		}
	}

	arm()

	guardTimer = setInterval(() => {
		if (stopped) return
		arm()
		// Fire directly, NOT via scheduleFire: the guard is a fallback
		// detector (not an event burst to coalesce), and routing it through
		// the debounce lets a guard interval shorter than the debounce starve
		// fire() indefinitely (timer reset before it ever elapses).
		const sig = fileSignature(settingsPath)
		if (sig !== undefined && sig !== lastSignature) fire()
	}, guardIntervalMs)
	guardTimer.unref?.()

	return () => {
		stopped = true
		if (debounceTimer) {
			clearTimeout(debounceTimer)
			debounceTimer = undefined
		}
		if (guardTimer) {
			clearInterval(guardTimer)
			guardTimer = undefined
		}
		try {
			watcher?.close()
		} catch {
			// Watcher already destroyed.
		}
		watcher = undefined
	}
}
