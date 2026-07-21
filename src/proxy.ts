import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"

/**
 * Idle (not total) timeout for stalled LLM SSE streams, in milliseconds.
 *
 * This value is consumed in two places that must stay in sync:
 *
 *   1. `installProxyAgent` below — sets undici's `bodyTimeout` on the global
 *      `EnvHttpProxyAgent`. `bodyTimeout` resets on every received chunk, so
 *      it only fires when the upstream truly stops sending bytes mid-stream.
 *      Note: pi-coding-agent's `configureHttpDispatcher()` (called inside
 *      `main()`) later overrides this dispatcher with a 300s `bodyTimeout`
 *      (default `DEFAULT_HTTP_IDLE_TIMEOUT_MS`), so the 120s value set here is
 *      only effective until `main()` runs. It still documents the intended
 *      shorter idle window and covers the pre-`main()` startup window.
 *   2. `patchedFetch` in `src/cli.ts` — wraps the response body `ReadableStream`
 *      with an idle timer that aborts the fetch via `AbortController` when no
 *      chunks arrive. This is the primary 120s seam.
 *
 * Both seams are effective under BOTH Node and the compiled Bun binary:
 * `patchedFetch` calls `undici.fetch` directly as `originalFetch` (not Bun's
 * native `globalThis.fetch`), so every fetch routes through undici's global
 * dispatcher. This makes (a) the wrapper's `controller.abort()` honored
 * mid-stream (undici.fetch propagates the AbortController signal to the body
 * stream; Bun's native fetch does not) and (b) undici's `bodyTimeout`
 * consulted as a defense-in-depth backstop. Whichever fires first wins, which
 * is the desired behaviour — the wrapper's 120s abort is the primary, and the
 * `bodyTimeout` (300s after `configureHttpDispatcher` runs) is the backstop.
 *
 * Env var:
 *   KIMCHI_STREAM_IDLE_TIMEOUT_MS – positive integer enables that value;
 *                                  0 explicitly disables (backwards compat);
 *                                  unset/empty/non-numeric/negative falls back
 *                                  to DEFAULT_STREAM_IDLE_TIMEOUT_MS (120000).
 */
export const STREAM_IDLE_TIMEOUT_MS_ENV = "KIMCHI_STREAM_IDLE_TIMEOUT_MS"
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000

export function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[STREAM_IDLE_TIMEOUT_MS_ENV] ?? "", 10)
	if (Number.isFinite(parsed) && parsed > 0) return parsed
	// Explicit opt-out: "0" disables the idle timeout (backwards compat).
	if (parsed === 0) return 0
	// Unset / empty / non-numeric / negative → apply the documented default.
	return DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

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
export function installProxyAgent(): void {
	const httpProxy = process.env.KIMCHI_PROXY ?? process.env.HTTP_PROXY ?? process.env.http_proxy
	const httpsProxy = process.env.KIMCHI_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
	const noProxy = process.env.KIMCHI_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy

	const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs()

	setGlobalDispatcher(
		new EnvHttpProxyAgent({
			// bodyTimeout is an IDLE timeout (resets on each chunk), not a total
			// deadline. A stalled SSE stream aborts after `streamIdleTimeoutMs`
			// of no bytes instead of hanging ~660s until the OS/provider closes
			// the socket. The provider SDK does NOT enforce its own stream-idle
			// deadline on the openai-completions path, so this finite value is the
			// only dispatcher-level thing that aborts a dead stream. Defaults to
			// 120000 (2 min) via KIMCHI_STREAM_IDLE_TIMEOUT_MS; set to 0 to disable
			// (back-compat).
			//
			// Effective under BOTH Node and the compiled Bun binary, because
			// `patchedFetch` (src/cli.ts) calls `undici.fetch` directly as
			// `originalFetch` — so every fetch routes through undici's global
			// dispatcher regardless of runtime. The `withStreamingIdleTimeout`
			// wrapper in `patchedFetch` provides the primary 120s abort (honored
			// because undici.fetch propagates AbortController to the body stream);
			// this `bodyTimeout` is the defense-in-depth backstop. Note:
			// pi-coding-agent's `configureHttpDispatcher()` (called inside
			// `main()`) overrides this dispatcher with a 300s `bodyTimeout`, so
			// this 120s value only holds until `main()` runs.
			bodyTimeout: streamIdleTimeoutMs,
			// headersTimeout is intentionally left at 0: headers always arrive in
			// <1s in the traces, and the original concern about vLLM header
			// stalls on local-LLM deployments still applies. The headers-phase
			// guard for Bun lives in `patchedFetch` (src/cli.ts).
			headersTimeout: 0,
			httpProxy,
			httpsProxy,
			noProxy,
		}),
	)
}
