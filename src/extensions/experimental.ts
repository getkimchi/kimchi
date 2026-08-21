/**
 * Shared experimental-features flag.
 *
 * `--enable-experimental-features` is parsed in `cli.ts` and STRIPPED
 * before args reach `main()`, so extensions cannot discover it via
 * `pi.getFlag`. This module is the bridge: cli.ts calls
 * `setExperimentalFeaturesEnabled(...)` once at startup; any extension
 * that needs to gate behavior on the flag reads
 * `isExperimentalFeaturesEnabled()`.
 *
 * Module-level singleton by design — the flag is a process-launch
 * decision, not session state. Subagent sessions share the process, so
 * they inherit the same value (and they should: an experimental tool is
 * either available in this build or not).
 */
let enabled = false

export function setExperimentalFeaturesEnabled(value: boolean): void {
	enabled = value
}

export function isExperimentalFeaturesEnabled(): boolean {
	return enabled
}
