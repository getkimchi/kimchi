/**
 * Always-on `session-metadata` extension.
 *
 * Buffers redacted settings changes into the session metadata store so they
 * can be injected into session exports (JSONL/HTML session writers) at
 * export time.
 *
 * This extension is **decoupled from the telemetry opt-in**: it starts its own
 * `startSettingsChangeWatcher()` unconditionally, so config changes are
 * captured whether or not telemetry is enabled. The watcher redacts each
 * changed value internally (via `redactValue()`) before invoking the emit
 * callback, so values are passed straight through to `recordConfigChange()`
 * without further redaction.
 *
 * Telemetry's own watcher — started by the telemetry extension when telemetry
 * is enabled — is left untouched. When telemetry is on, two concurrent
 * `fs.watch` listeners observe `settings.json`; this is acceptable and
 * isolated: each owns its own watcher handle and debounce timer, and they do
 * not share state. When telemetry is disabled, telemetry returns early and
 * its watcher never starts — but this extension still captures changes.
 *
 * The extension never throws: the emit callback body is wrapped in try/catch
 * so a failure in `recordConfigChange` (which itself never throws) cannot
 * crash the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { recordConfigChange } from "../../utils/session-metadata-store.js"
import { startSettingsChangeWatcher } from "../telemetry/settings-change-emitter.js"

/**
 * Factory for the always-on session-metadata extension. Takes no config — it
 * runs regardless of telemetry opt-in. Returns the inner `(pi) => void`
 * lifecycle function expected by the extension registration in `cli.ts`.
 */
export default function sessionMetadataExtension() {
	return (pi: ExtensionAPI): void => {
		// Start watching settings.json for changes. The watcher invokes `emit`
		// once per changed key with `{ key, value }` where `value` is already
		// redacted internally — we pass it straight through to the store.
		const stopWatcher = startSettingsChangeWatcher((event, properties) => {
			try {
				if (event !== "config_changed") return
				recordConfigChange(String(properties.key), properties.value)
			} catch {
				// Never let a buffered config change crash the session.
			}
		})

		// Stop is idempotent — session_shutdown (and any duplicate teardown)
		// only closes the watcher once.
		let stopped = false
		const stop = (): void => {
			if (stopped) return
			stopped = true
			stopWatcher()
		}

		// Mirror telemetry's convention: stop the watcher on session_shutdown
		// to close the fs.watch handle and clear the debounce timer (prevents
		// handle leak / hang).
		pi.on("session_shutdown", () => {
			stop()
		})
	}
}
