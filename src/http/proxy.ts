import * as undici from "undici"

// NOTE: proxy.ts is statically imported by entry.ts BEFORE PI_PACKAGE_DIR is
// set. Import nothing here that transitively reaches
// @earendil-works/pi-coding-agent (e.g. stream-idle-timeout.js →
// settings-watcher.js) — pi's config.js snapshots package.json at load time,
// and loading it early unbrands the compiled binary (π title, `.pi` config
// dir). See idle-timeout-override.ts.
import { setStreamIdleTimeoutOverride } from "./idle-timeout-override.js"

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
 *
 * Runtime caveat: this whole module is a compatibility layer for Node-hosted
 * runs — the npm `bin` entry point and anything else that launches kimchi
 * with `node` (e.g. an IDE spawning the ACP server). Node's fetch has no
 * built-in proxy env-var support, so without this layer those users can't
 * get through a corporate proxy. Under Bun (the shipped compiled binary and
 * `pnpm dev`) every undici call here is inert: Bun aliases the "undici"
 * specifier to a builtin shim whose dispatcher its native fetch ignores (and
 * which lacks `install`). That is fine for the standard env vars — Bun's
 * fetch honours HTTP_PROXY/HTTPS_PROXY/NO_PROXY natively — but it means the
 * KIMCHI_PROXY/KIMCHI_NO_PROXY overrides only take effect under Node, since
 * only the dispatcher below knows about them.
 */
function resolveProxyEnv() {
	return {
		httpProxy: process.env.KIMCHI_PROXY ?? process.env.HTTP_PROXY ?? process.env.http_proxy,
		httpsProxy: process.env.KIMCHI_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy,
		noProxy: process.env.KIMCHI_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy,
	}
}

function createDispatcher() {
	const { httpProxy, httpsProxy, noProxy } = resolveProxyEnv()
	return new undici.EnvHttpProxyAgent({
		// bodyTimeout/headersTimeout DEFAULT to 300s in undici when unset, so
		// they must be explicitly zeroed — omitting them does not mean
		// "disabled". The fetch wrapper in src/http/stream-idle-timeout.ts is
		// the sole idle-timeout enforcement layer on every runtime; a lingering
		// dispatcher default would kill long quiet streams at 300s under Node
		// (UND_ERR_BODY_TIMEOUT on e.g. vLLM buffering a large tool call) even
		// when the user raised or disabled httpIdleTimeoutMs.
		allowH2: false,
		bodyTimeout: 0,
		headersTimeout: 0,
		httpProxy,
		httpsProxy,
		noProxy,
	})
}

/**
 * Reconfigure the HTTP idle timeout with a settings-resolved value or a live
 * getter (preferred — re-read on every request, so mid-session settings edits
 * apply without a restart).
 *
 * Called after settings are loaded in code paths that bypass pi-mono's main()
 * (e.g. ACP mode). Feeds the fetch-wrapper override — the enforcement layer
 * that works everywhere, including the Bun binary (src/http/stream-idle-timeout.ts).
 */
export function configureHttpIdleTimeout(timeout: number | (() => number)): void {
	setStreamIdleTimeoutOverride(timeout)
}

export function installProxyAgent(): void {
	undici.setGlobalDispatcher(createDispatcher())
	// undici.install() replaces globalThis.fetch with undici's fetch so that
	// Node's bundled fetch and the npm-undici dispatcher stay on the same
	// implementation — Node 26's bundled fetch can otherwise consume compressed
	// responses through the npm dispatcher without decompressing, breaking
	// response.json(). Must run once at startup, before cli.ts patches
	// globalThis.fetch with the user-agent wrapper; must NOT run again later,
	// or it wipes that wrapper. Optional-called via the namespace import: Bun's
	// undici shim has no `install` (a named import of it crashes the compiled
	// binary at startup), and under Bun there is nothing to unify anyway.
	undici.install?.()
}
