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
export function installProxyAgent(): void {
	const httpProxy = process.env.KIMCHI_PROXY ?? process.env.HTTP_PROXY ?? process.env.http_proxy
	const httpsProxy = process.env.KIMCHI_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
	const noProxy = process.env.KIMCHI_NO_PROXY ?? process.env.NO_PROXY ?? process.env.no_proxy

	setGlobalDispatcher(
		new EnvHttpProxyAgent({
			// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM
			// stalls (e.g. vLLM buffering a large tool call) exceed that and abort
			// the SSE stream with UND_ERR_BODY_TIMEOUT. Disable both — provider
			// SDKs enforce their own AbortController-based deadlines.
			bodyTimeout: 0,
			headersTimeout: 0,
			httpProxy,
			httpsProxy,
			noProxy,
		}),
	)
}
