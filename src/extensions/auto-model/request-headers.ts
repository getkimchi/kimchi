import type { ProviderHeaders } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "./constants.js"

/**
 * The gateway headers that pin a request to one provider integration
 * ("X-Provider-Type", "X-Provider-Name"). They are stamped per provider
 * block in models.json (buildModelsConfig in src/models.ts) — the kimchi-dev
 * block carries `X-Provider-Type: ai-enabler` because the block's concrete
 * models are ai-enabler-served.
 *
 * A routed virtual model (provider kimchi-dev, id `auto*`) lives in that
 * same block, so its requests would inherit the ai-enabler pin — and the
 * gateway would resolve `auto` against ai-enabler integrations only,
 * silently dropping models the user's auto-routing rule allows from other
 * integrations. The gateway treats a missing/empty header as unscoped, so
 * auto-routed requests must go out without these headers. The block-level
 * stamps stay untouched; only outgoing request headers are stripped.
 */
const PROVIDER_PINNING_HEADERS = new Set(["x-provider-type", "x-provider-name"])

/**
 * Remove the provider-pinning headers from an assembled request header set.
 *
 * Matching is case-insensitive: HTTP header names are case-insensitive on
 * the wire, and the block-level stamps are regenerated per discovery, so
 * the strip must not depend on exact casing. Other headers (auth,
 * organization, user agent) pass through untouched, `null` values included
 * — a null value keeps its "delete this header" semantics downstream.
 */
export function stripProviderPinningHeaders(headers: ProviderHeaders): ProviderHeaders {
	const stripped: ProviderHeaders = {}
	for (const [name, value] of Object.entries(headers)) {
		if (PROVIDER_PINNING_HEADERS.has(name.toLowerCase())) continue
		stripped[name] = value
	}
	return stripped
}

const decorated = new WeakSet<ModelRuntime>()

/**
 * Decorate Pi's runtime factory so requests for routed virtual models go
 * out without the provider-pinning headers. `getAuth` is the one method
 * every consumer resolves a model's request headers through, so stripping
 * there covers both shapes of caller with one seam:
 *
 * - streamed requests (agent loop, compaction, subagents, side chats — on
 *   both the TUI and ACP surfaces) assemble their headers in
 *   `prepareRequest`, which resolves through `getAuth`;
 * - direct callers (via ModelRegistry.getApiKeyAndHeaders): compaction
 *   resilience, the ferment judges/evaluators, and the work-attribution
 *   matcher issue their own provider calls with the resolved headers,
 *   bypassing the stream path entirely.
 *
 * The strip keys on the exact request model `getAuth` was called with, and
 * runs after upstream merges any model-level config headers, so the
 * resolved header set for an auto-routed model never carries the pin.
 */
export function withAutoRoutingHeaderStrip(create: typeof ModelRuntime.create): typeof ModelRuntime.create {
	return async (options) => {
		const runtime = await create(options)
		if (decorated.has(runtime)) return runtime
		decorated.add(runtime)
		const getAuth = runtime.getAuth.bind(runtime)
		runtime.getAuth = async (providerOrModel, overrides) => {
			// Provider-id lookups carry no model identity, so the strip cannot apply
			// here — by design. Header resolution for an auto-routed request must
			// always go through the model-object form; resolving by provider id
			// would leak the block-level pinning headers.
			if (typeof providerOrModel === "string") return getAuth(providerOrModel, overrides)
			const resolution = await getAuth(providerOrModel, overrides)
			if (!resolution?.auth.headers || !isAutoRoutedModel(providerOrModel)) return resolution
			return {
				...resolution,
				auth: { ...resolution.auth, headers: stripProviderPinningHeaders(resolution.auth.headers) },
			}
		}
		return runtime
	}
}

let installed = false

/** Install the request-header strip process-wide (see installAutoModelAdapters). */
export function installAutoRoutingHeaderStrip(): void {
	if (installed) return
	installed = true
	ModelRuntime.create = withAutoRoutingHeaderStrip(ModelRuntime.create.bind(ModelRuntime))
}
