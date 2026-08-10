/**
 * Minimal debug logging for otherwise-swallowed best-effort failures (telemetry, progress
 * events, workspace-restore fallbacks). Disabled by default so normal runs stay silent; set
 * KIMCHI_COUNCIL_DEBUG=1 to see these on stderr while investigating a field report.
 */
export function debugLog(message: string, error?: unknown): void {
	if (!process.env.KIMCHI_COUNCIL_DEBUG) return
	if (error === undefined) {
		console.error(`[council] ${message}`)
	} else {
		console.error(`[council] ${message}`, error)
	}
}
