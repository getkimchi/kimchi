import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
	MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { setMultiModelEnabled } from "../multi-model.js"
import { syncAutoCapabilities } from "../router/capabilities.js"
import { AUTO_MODEL_PROVIDER } from "../router/constants.js"
import { clearAutoRoutingState, setAutoRoutingState } from "../router/state.js"
import { type RoutedModelResolution, resolveRoutedModel } from "./routed-model.js"

export const ROUTED_MODEL_RESOLUTION_ENTRY = "kimchi_routed_model_resolution"

/** Persisted in the session log so the pick notice survives resume and renders. */
type PersistedRoutedResolution = {
	version: 1
	requestedId: string
	provider: string
	modelId: string
}

function isPersistedRoutedResolution(data: unknown): data is PersistedRoutedResolution {
	return (
		data !== null &&
		typeof data === "object" &&
		"version" in data &&
		data.version === 1 &&
		"requestedId" in data &&
		typeof data.requestedId === "string" &&
		"provider" in data &&
		typeof data.provider === "string" &&
		"modelId" in data &&
		typeof data.modelId === "string"
	)
}

function routedEntry(resolution: RoutedModelResolution, requestedId: string): PersistedRoutedResolution {
	return {
		version: 1,
		requestedId,
		provider: AUTO_MODEL_PROVIDER,
		modelId: resolution.kind === "unknown" ? resolution.rawId : resolution.model.id,
	}
}

function routedIdOf(resolution: RoutedModelResolution): string {
	return resolution.kind === "unknown" ? resolution.rawId : resolution.model.id
}

/** Rendered when the backend routes a request to a concrete model. */
function formatRoutedPickNotice(requestedId: string, routedId: string): string {
	return `${requestedId} picked ${routedId}.`
}

/**
 * Per-session id of the routed model last announced, so a pick notice is only
 * appended when the backend actually routes to a different model. Keyed by
 * session id just like the shared routing state.
 */
const lastNotifiedModel = new Map<string, string>()

function resetLastNotified(sessionId: string): void {
	lastNotifiedModel.delete(sessionId)
}

/** @internal — test hook to clear the module-level notice-dedup map. */
export function _resetAutoModelNoticeCache(): void {
	lastNotifiedModel.clear()
}

/**
 * A backend-routed virtual model the harness should watch for. Any kimchi-dev
 * model is eligible — the backend routes `auto-beta` today, without the harness
 * special-casing ids.
 */
function isRoutableProvider(model: { provider: string } | undefined): boolean {
	return model?.provider === AUTO_MODEL_PROVIDER
}

export function createAutoModelRoutingExtension(): ExtensionFactory {
	/**
	 * Learn the routed pick from a streamed/committed assistant message and, when
	 * it changed, announce it and re-sync capabilities. Fires from `message_update`
	 * (near stream-start, matching v1's early notice) and from `message_end` as a
	 * fallback for responses that never streamed a `message_update`
	 * (e.g. non-streamed providers). Idempotent per pick via `lastNotifiedModel`.
	 */
	function applyRoutedResolution(
		pi: ExtensionAPI,
		message: MessageEndEvent["message"],
		ctx: ExtensionContext,
		sessionId: string,
	): void {
		if (message.role !== "assistant") return
		if (message.provider !== AUTO_MODEL_PROVIDER) return
		if (!message.responseModel || message.responseModel === message.model) return

		const resolution = resolveRoutedModel(message.provider, message.responseModel, ctx.modelRegistry)
		const routedId = routedIdOf(resolution)

		// Announce only when the routed model changed, so a session that keeps
		// landing on the same concrete model isn't spammed. Grouping the state
		// write, capability sync, and notice behind this guard is what makes the
		// (per-token) `message_update` path safe: these run once per pick, not
		// once per streamed token.
		if (lastNotifiedModel.get(sessionId) === routedId) return
		lastNotifiedModel.set(sessionId, routedId)

		// Backend-reachable concrete model: record it and re-sync capabilities
		// to its real window/tokens so compaction and thinking controls match.
		// ctx.model is the requested virtual descriptor; copying it onto the
		// routed target's capabilities keeps the requested id honest while the
		// effective window drives context management.
		if (resolution.kind !== "unknown") {
			setAutoRoutingState(sessionId, { status: "resolved", model: resolution.model, requestedId: message.model })
			if (ctx.model) {
				void syncAutoCapabilities(pi, ctx.model as Model<Api>, resolution.model as Model<Api>).catch(() =>
					clearAutoRoutingState(sessionId),
				)
			}
		} else {
			// The backend routed to a model the catalog doesn't know: drop any prior
			// resolved pick so downstream resolvers and telemetry fall back to the
			// advertised descriptor (and don't show a stale `(old-model)` label)
			// until a known pick arrives.
			clearAutoRoutingState(sessionId)
		}

		pi.appendEntry(ROUTED_MODEL_RESOLUTION_ENTRY, routedEntry(resolution, message.model))
	}

	return (pi: ExtensionAPI) => {
		// Custom entries stay out of LLM context but render in the transcript, so
		// `<requested> picked <routed>.` is visible on resume without leaking into
		// future model requests.
		pi.registerEntryRenderer(ROUTED_MODEL_RESOLUTION_ENTRY, (entry, _options, theme) => {
			if (!isPersistedRoutedResolution(entry.data)) return undefined
			return new Text(theme.fg("dim", formatRoutedPickNotice(entry.data.requestedId, entry.data.modelId)), 0, 0)
		})

		// `message_update` fires from the first streamed chunk carrying `model`, so
		// the notice appears near stream-start (matching v1) rather than at turn-end.
		pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
			applyRoutedResolution(pi, event.message, ctx, ctx.sessionManager.getSessionId())
		})

		// Fallback for non-streamed responses that never emit `message_update`.
		pi.on("message_end", (event: MessageEndEvent, ctx) => {
			applyRoutedResolution(pi, event.message, ctx, ctx.sessionManager.getSessionId())
		})

		pi.on("session_start", async (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			if (!ctx.model || !isRoutableProvider(ctx.model)) {
				resetLastNotified(sessionId)
				return
			}
			// A selected model on the `kimchi-dev` provider must not be wrapped by
			// multi-model. This covers every `kimchi-dev` session model (routed
			// virtual ids and v1 `auto`), which is safe because none of them use
			// multi-model.
			setMultiModelEnabled(sessionId, false)

			const last = ctx.sessionManager
				.getEntries()
				.findLast(
					(candidate) =>
						candidate.type === "custom" &&
						candidate.customType === ROUTED_MODEL_RESOLUTION_ENTRY &&
						isPersistedRoutedResolution(candidate.data),
				)
			const data = last?.type === "custom" ? (last.data as PersistedRoutedResolution) : undefined
			if (!data || data.requestedId !== ctx.model.id) {
				resetLastNotified(sessionId)
				return
			}

			lastNotifiedModel.set(sessionId, data.modelId)
			const concrete = ctx.modelRegistry.find(data.provider, data.modelId)
			if (concrete && concrete.id !== ctx.model.id) {
				setAutoRoutingState(sessionId, { status: "resolved", model: concrete, requestedId: data.requestedId })
				try {
					const ok = await syncAutoCapabilities(pi, ctx.model as Model<Api>, concrete as Model<Api>)
					// A failed sync degrades to the advertised descriptor (e.g. the
					// routed model was just removed from the catalog); non-fatal.
					if (!ok) clearAutoRoutingState(sessionId)
				} catch {
					clearAutoRoutingState(sessionId)
				}
			}
		})

		// When the user switches to a different model, invalidate the per-session
		// pick so re-selecting a virtual model re-runs the capability sync. Without
		// this, the dedup guard would short-circuit on a repeated pick after a
		// switch-away, leaving the advertised (e.g. 1M) window applied while the
		// serving model is smaller. Guarded on an actual id change so a no-op
		// select (e.g. resume) doesn't clobber the hydrated pick.
		pi.on("model_select", (event: { model: { id: string }; previousModel?: { id: string } | undefined }, ctx) => {
			const prev = event.previousModel?.id
			if (prev === undefined || prev === event.model.id) return
			const sessionId = ctx.sessionManager.getSessionId()
			// Reset the notice + sync dedup so re-selecting a virtual model re-runs
			// the capability sync, but KEEP the resolved routing state: feedback's
			// model_select handler reads it (via isRoutedModel) to decide whether a
			// switch away from a routed virtual model should prompt for a reason.
			// The state is inert while a different model is selected (resolvers only
			// match the currently-selected id) and is overwritten on the next resolve.
			resetLastNotified(sessionId)
		})

		pi.on("session_shutdown", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			resetLastNotified(sessionId)
			clearAutoRoutingState(sessionId)
		})
	}
}

const autoModelExtension = createAutoModelRoutingExtension()

export default autoModelExtension
