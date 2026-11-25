import { resolve } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { type HostPorts, setDefaultHostPorts } from "@getkimchi/kimchi-bridge/reconcile"
import { resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig, readGitToken, readPrReportingConsent, resolveEndpoints } from "../../config.js"
import { isResourceEnabled } from "../../resources/store.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { readE2eSeam } from "../e2e-seam.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"

/**
 * E2E seams the kimchi-bridge library reads through the HostPorts e2eSeam port
 * (reconcile-out-of-process K1): the reading code moved to the bridge, so this
 * allowlist is what Kimchi's env-var registry (src/env-vars.ts) still sees as
 * the variable's live consumer. A seam the bridge does not read stays invisible
 * to it even when set.
 */
const BRIDGE_E2E_SEAMS = new Set(["KIMCHI_E2E_COST_REPORT_REFRESH_MS"])

/**
 * Kimchi's in-process HostPorts: the bridge's ledger and reconcile code
 * (moved in the reconcile-out-of-process plan) resolves credentials, endpoints,
 * org policy, telemetry consent and metrics through these ports instead of
 * holding a second copy of Kimchi's config, trust and policy logic.
 *
 * Every port forwards to the exact function the moved code called before the
 * move, so each decision is byte-for-byte the old one:
 *
 * - `credentials(cwd)` is the old `credentialOf(cwd)` in work-attribution/scope.ts:
 *   `loadConfig({ cwd })` (env key > trusted project .kimchi/config.json > global
 *   config — an untrusted project never overrides) read once, then
 *   `resolveGatewayCredentials(config)` and the platform API from the same
 *   `resolveEndpoints({ cwd, config })`.
 * - `gitToken(host)` is `readGitToken(host)` from config.ts (gitTokens.<host>).
 * - `endpoints(cwd)` is `resolveEndpoints({ cwd })` (billing-source compared
 *   gateway URLs against exactly these bases).
 * - `orgPolicy().resourceEnabled(id)` is `isResourceEnabled(id)`.
 * - `telemetryConsent()` is `isTelemetryEnabled()`.
 * - `reportingConsent()` is `readPrReportingConsent()` — a live read of the config-owned
 *   `prReporting` key (undefined while unmigrated; "off" when the config is unreadable),
 *   never a cached value, so an explicit `/pr-reporting off` applies to the next read.
 * - `metric(m)` is `trackPRCostMetric(m)`.
 * - `fetch` is the global instrumented fetch (installGlobalFetchInstrumentation
 *   patches it before any reconcile code runs).
 * - `e2eSeam(name)` is `readE2eSeam(name)` for the seams the bridge reads
 *   (BRIDGE_E2E_SEAMS) and undefined for anything else.
 *
 * The ports take the session cwd as a parameter, so one process-wide default
 * (installed once at startup, see installKimchiHostPorts) is correct even for
 * the ACP server, which hosts many sessions in one process. Never use
 * process.cwd() here.
 */
export function kimchiHostPorts(): HostPorts {
	return {
		agentDir: resolve(getAgentDir()),
		e2eSeam: (name) => (BRIDGE_E2E_SEAMS.has(name) ? readE2eSeam(name) : undefined),
		now: Date.now,
		credentials(cwd) {
			const config = loadConfig({ cwd })
			const credentials = resolveGatewayCredentials(config)
			return {
				token: credentials.token,
				organizationId: credentials.organizationId,
				apiUrl: resolveEndpoints({ cwd, config }).platformApiUrl.replace(/\/+$/, ""),
			}
		},
		gitToken: (host) => readGitToken(host),
		endpoints: (cwd) => resolveEndpoints({ cwd }),
		orgPolicy: () => ({ resourceEnabled: (id) => isResourceEnabled(id) }),
		telemetryConsent: isTelemetryEnabled,
		reportingConsent: () => readPrReportingConsent(),
		metric: trackPRCostMetric,
		fetch: (input, init) => fetch(input, init),
	}
}

/**
 * Install the process-wide default host ports. Idempotent; called once at
 * startup (cli.ts, before any extension or instrumentation runs). Tests and
 * the standalone ledger driver — processes that run bridge reconcile code
 * without cli.ts — install it themselves, because code reached outside a pass
 * context (the supervisor's inline passes and command handlers alike) reads
 * the default rather than receiving a host.
 */
export function installKimchiHostPorts(): void {
	setDefaultHostPorts(kimchiHostPorts())
}
