// Per-message model attribution for ACP clients: every agent response chunk
// stream carries, on the FIRST chunk emitted for each messageId, a `_meta`
// payload naming the model that produced the response. Composed purely from
// the assistant message tuple — no catalog lookup — so it works for pinned
// models, routed virtual models (requested ≠ served), and backend-redirected
// pins alike. The client rule is last-wins per messageId: a later chunk of
// the same id re-carries `_meta` only when the value changed (a served-model
// correction after `responseModel` arrives mid-stream).
//
// Wire contract (frozen, documented in docs/acp-model-attribution.md):
//   _meta: { "kimchi.dev": { modelId, requestedModelId } }
// Both fields are `provider/modelId` refs, joinable against
// SessionModelState.availableModels — the same id format the `routed_model`
// ext notification carries, so every kimchi ACP surface names models
// identically.

import type { AssistantMessage } from "@earendil-works/pi-ai"
import { refFromParts } from "../../extensions/model-catalog/ref-utils.js"
import { type KimchiDevMeta, kimchiDevMetaOf } from "./capabilities.js"

export interface ModelAttribution {
	/** Ref of the model that served the response: `provider/responseModel` when the backend reported one, else `provider/model`. */
	modelId: string
	/** Ref of the model the request was addressed to: `provider/model` — the virtual id when routed. */
	requestedModelId: string
}

/** The `_meta` value a chunk carries: the attribution namespaced under the kimchi.dev key. */
export type ModelMeta = KimchiDevMeta<ModelAttribution>

/**
 * Compose the attribution for one assistant message. `responseModel` is the
 * provider-reported served model (present whenever routing or a redirect
 * happened); when absent the request itself was served, so both refs fall
 * back to the requested id.
 */
export function modelAttributionFrom(
	message: Pick<AssistantMessage, "provider" | "model" | "responseModel">,
): ModelAttribution {
	return {
		modelId: refFromParts(message.provider, message.responseModel ?? message.model),
		requestedModelId: refFromParts(message.provider, message.model),
	}
}

/**
 * First-chunk dedup: returns the `_meta` value to spread onto a chunk when
 * this messageId has not carried an attribution yet — or when the
 * attribution changed (the correction case) — and records it; `undefined`
 * when the id already carried exactly this attribution, so repeated chunks
 * of a streamed message stay lean. Without a messageId or seen-map (replay
 * wiring without a loaded record) dedup is impossible, so it always
 * attaches.
 */
export function modelMetaFor(
	seen: Map<string, ModelAttribution> | undefined,
	messageId: string | undefined,
	attribution: ModelAttribution,
): ModelMeta | undefined {
	if (messageId === undefined || seen === undefined) {
		return kimchiDevMetaOf(attribution)
	}
	const previous = seen.get(messageId)
	if (previous?.modelId === attribution.modelId && previous.requestedModelId === attribution.requestedModelId) {
		return undefined
	}
	seen.set(messageId, attribution)
	return kimchiDevMetaOf(attribution)
}

/**
 * Spread helper for the chunk emitters: `{ _meta }` when modelMetaFor produced
 * a value, `{}` when the chunk should carry none — emit sites read
 * `...spreadModelMeta(modelMetaFor(...))` and stay one line each.
 */
export function spreadModelMeta(modelMeta: ModelMeta | undefined): { _meta?: ModelMeta } {
	return modelMeta === undefined ? {} : { _meta: modelMeta }
}
