/**
 * Disables upstream pi's install telemetry inside kimchi.
 *
 * pi's InteractiveMode sends an anonymous install/update ping to
 * https://pi.dev/api/report-install whenever the startup changelog check
 * detects a fresh install or an update, and the SDK stamps pi attribution
 * headers (HTTP-Referer: https://pi.dev, X-OpenRouter-Title: pi, ...) onto
 * requests routed through OpenRouter, NVIDIA NIM, and Cloudflare. Both paths
 * share pi's `isInstallTelemetryEnabled` gate, which `PI_TELEMETRY` overrides
 * at call time.
 *
 * Two independent layers:
 * - entry.ts sets PI_TELEMETRY=0 before any pi code loads (earliest hook).
 * - applyPiTelemetryPatch() re-asserts the env kill (making this module's
 *   contract self-contained and unit-testable) and no-ops
 *   `reportInstallTelemetry` on the InteractiveMode prototype, so the ping
 *   cannot fire even if a future pi release changes the env contract.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent"

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype mutation
const imProto = InteractiveMode.prototype as any

export function applyPiTelemetryPatch(): void {
	// Unconditional override — kimchi never sends telemetry to pi, even when
	// the user or pi's /settings toggle opts in.
	process.env.PI_TELEMETRY = "0"
	// Async no-op: the installed upstream method returns void (fire-and-forget),
	// but an async no-op also stays contract-compatible if a future pi release
	// starts returning or consuming a Promise at the call site.
	imProto.reportInstallTelemetry = async () => {}
}
