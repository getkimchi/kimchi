/**
 * Global fetch instrumentation, installed once at startup.
 *
 * Patching `globalThis.fetch` is deliberate: pi-ai constructs its vendor SDK
 * clients internally and exposes no fetch or transport injection point, so
 * the global is the only single choke point that covers model completions,
 * OAuth flows, MCP HTTP transports and kimchi's own requests alike.
 *
 * Install happens in entry.ts, right after installProxyAgent() and BEFORE the
 * auto-update check: under Bun the wrapper is the only layer that bounds a
 * stalled connection, and an uninstrumented update download could hang launch
 * until the OS TCP timeout (~11 min). The billing hook can't exist that early
 * (config loading lives in cli.ts), so it attaches later via the second
 * installGlobalFetchInstrumentation call — see the options doc.
 */

import { requestUrl, rewrapResponseWithBody, wrapFetchWithIdleTimeout } from "./stream-idle-timeout.js"

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Registered via Symbol.for so the brand survives module duplication (bundled
 * binary vs. source imports in tests): a second install must see the first
 * one's mark and back off instead of stacking another chain of wrappers.
 * (The deferred billing hook below is module state, so it does assume a
 * single copy of this module in the process — true for both the compiled
 * binary and the source tree.)
 */
const fetchPatchedSymbol = Symbol.for("kimchi.fetchPatched")

type BrandedFetch = FetchFn & Record<symbol, boolean | undefined>

/**
 * Deferred billing hook: entry.ts installs the wrapper before config loading
 * exists, cli.ts attaches the hook once it does. Read at request time by the
 * already-installed patched fetch.
 */
let onModelCompletionSettled: ((originalFetch: FetchFn) => Promise<unknown>) | undefined

export interface GlobalFetchInstrumentationOptions {
	/** Default user-agent, applied when the caller supplies none. */
	userAgent: string
	/**
	 * Kicked off after each model-completion response settles (body fully
	 * read, errored, or cancelled). Receives the unpatched fetch so the
	 * callback's own request bypasses the instrumentation layers. Optional:
	 * entry.ts installs without it; cli.ts's later call attaches it to the
	 * already-patched fetch (the hook is updated even when the install
	 * itself is a no-op).
	 */
	onModelCompletionSettled?: (originalFetch: FetchFn) => Promise<unknown>
}

/** Replace `globalThis.fetch` with the instrumented version. Safe to call more than once — later calls only update the billing hook. */
export function installGlobalFetchInstrumentation(options: GlobalFetchInstrumentationOptions): void {
	if (options.onModelCompletionSettled) {
		onModelCompletionSettled = options.onModelCompletionSettled
	}
	if ((globalThis.fetch as BrandedFetch)[fetchPatchedSymbol]) return

	const originalFetch: FetchFn = globalThis.fetch.bind(globalThis)
	// Idle timeout for all outbound requests: under Bun the undici
	// dispatcher timeouts are inert, so this wrapper is the only layer
	// that actually terminates stalled connections in the shipped binary.
	const idleFetch = wrapFetchWithIdleTimeout(originalFetch)
	const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		// When input is a Request object, passing any init.headers replaces the
		// Request's entire header list per the fetch spec — so the base headers
		// must be derived from the Request when init doesn't carry its own, or
		// forwarding our user-agent would silently strip authorization et al.
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
		if (!headers.has("user-agent")) {
			headers.set("user-agent", options.userAgent)
		}
		const response = await idleFetch(input, { ...init, headers })
		const hook = onModelCompletionSettled
		return hook && isModelCompletionFetch(input)
			? withBillingRefreshAfterResponseSettles(response, () => hook(originalFetch))
			: response
	}
	;(patchedFetch as BrandedFetch)[fetchPatchedSymbol] = true
	globalThis.fetch = patchedFetch
}

function isModelCompletionFetch(input: RequestInfo | URL): boolean {
	return /\/chat\/completions(?:$|[?#])/.test(requestUrl(input) ?? "")
}

function withBillingRefreshAfterResponseSettles(response: Response, refreshBilling: () => Promise<unknown>): Response {
	const body = response.body
	if (!body) {
		void refreshBilling()
		return response
	}

	const reader = body.getReader()
	let refreshScheduled = false
	const refreshOnce = () => {
		if (refreshScheduled) return
		refreshScheduled = true
		void refreshBilling()
	}
	const wrappedBody = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					refreshOnce()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				refreshOnce()
				controller.error(error)
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				refreshOnce()
			}
		},
	})

	return rewrapResponseWithBody(response, wrappedBody)
}
