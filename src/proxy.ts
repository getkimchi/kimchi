import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"

/**
 * Install undici's EnvHttpProxyAgent as the global dispatcher so that
 * Node's native fetch (and anything else using undici underneath) honours
 * proxy environment variables.
 *
 * Supported env vars (in precedence order):
 *   KIMCHI_PROXY      – explicit override, used for both HTTP and HTTPS
 *   HTTP_PROXY        – standard, http:// scheme
 *   HTTPS_PROXY       – standard, https:// scheme
 *   NO_PROXY          – comma/space separated list of hosts to bypass
 *   KIMCHI_NO_PROXY   – explicit override for the no-proxy list
 *
 * The upstream pi-coding-agent cli.js does the same thing, but kimchi
 * bypasses that entry point, so we replicate it here.
 */

/**
 * Idle (not total) timeout for the SSE body stream, in milliseconds.
 *
 * undici's `bodyTimeout` resets every time a chunk is received, so it only
 * fires when the upstream truly stops sending bytes mid-stream. The provider
 * SDK's streaming client does NOT enforce its own AbortController deadline,
 * so without a finite `bodyTimeout` a stalled stream hangs for ~660s until
 * the OS/provider closes the socket — burning most of a trial's wall-clock
 * budget per hang. A finite idle timeout aborts the dead stream and lets the
 * existing retry infrastructure retry immediately.
 *
 * Env var:
 *   KIMCHI_STREAM_IDLE_TIMEOUT_MS – positive integer enables that value;
 *                                  0 explicitly disables (backwards compat);
 *                                  unset/empty/non-numeric/negative falls back
 *                                  to DEFAULT_STREAM_IDLE_TIMEOUT_MS (180000).
 */
export const STREAM_IDLE_TIMEOUT_MS_ENV = "KIMCHI_STREAM_IDLE_TIMEOUT_MS"
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180000

export function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[STREAM_IDLE_TIMEOUT_MS_ENV] ?? "", 10)
	if (Number.isFinite(parsed) && parsed > 0) return parsed
	// Explicit opt-out: "0" disables the idle timeout (backwards compat).
	if (parsed === 0) return 0
	// Unset / empty / non-numeric / negative → apply the documented default.
	return DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

export function installProxyAgent(): void {
	const httpProxy = process.env.KIMCHI_PROXY ?? process.env.HTTP_PROXY ?? process.env.http_proxy
	const httpsProxy = process.env.KIMCHI_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
	const noProxy = process.env.KIMCHI_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy

	const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs()

	setGlobalDispatcher(
		new EnvHttpProxyAgent({
			// bodyTimeout is an IDLE timeout (resets on each chunk), not a total
			// deadline. A stalled SSE stream now aborts after `streamIdleTimeoutMs`
			// of no bytes instead of hanging ~660s until the OS/provider closes
			// the socket. The provider SDK does NOT enforce its own stream-idle
			// deadline on the openai-completions path, so this finite value is the
			// only thing that aborts a dead stream. Defaults to 180000 (3 min) via
			// KIMCHI_STREAM_IDLE_TIMEOUT_MS; set to 0 to disable (back-compat).
			bodyTimeout: streamIdleTimeoutMs,
			// headersTimeout is intentionally left at 0: headers always arrive in
			// <1s in the traces, and the original concern about vLLM header
			// stalls on local-LLM deployments still applies.
			headersTimeout: 0,
			httpProxy,
			httpsProxy,
			noProxy,
		}),
	)
}
