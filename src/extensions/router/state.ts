import type { Model } from "@earendil-works/pi-ai"
import type { ExtensionContext, ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAutoModel } from "./constants.js"

export const AUTO_RESOLUTION_ENTRY = "kimchi_auto_resolution"

export type AutoFailureReason =
	| "cancelled"
	| "empty_prompt"
	| "interrupted"
	| "malformed"
	| "model_update_failed"
	| "network"
	| "no_auth"
	| "redaction_failed"
	| "router_http"
	| "timeout"
	| "unavailable_recommendation"
	| "vision_required"

export type AutoRoutingState =
	| { status: "unresolved" }
	| { status: "attempting" }
	// `requestedId` identifies the virtual model this resolution applies to.
	// v1 resolved state (and legacy persisted hydration) may omit it; those
	// fall back to the v1 `isAutoModel` semantics in `resolveEffectiveModel`.
	| { status: "resolved"; model: Model<string>; requestedId?: string }
	| { status: "failed"; reason: AutoFailureReason }

type PersistedAutoResolution = { version: 1; status: "resolved"; provider: string; modelId: string }

const stateBySession = new Map<string, AutoRoutingState>()

export function getAutoRoutingState(sessionId: string | undefined): AutoRoutingState {
	if (!sessionId) return { status: "failed", reason: "interrupted" }
	return stateBySession.get(sessionId) ?? { status: "unresolved" }
}

export function setAutoRoutingState(sessionId: string, state: AutoRoutingState): void {
	stateBySession.set(sessionId, state)
}

export function clearAutoRoutingState(sessionId: string): void {
	stateBySession.delete(sessionId)
}

/**
 * Pi restores the model recorded on the last assistant message. Auto messages
 * name their concrete target, so use explicit selection entries and Auto's
 * persisted state to recover the user-facing model instead.
 */
export function sessionSelectsAuto(entries: readonly SessionEntry[]): boolean {
	let selected = false
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === AUTO_RESOLUTION_ENTRY &&
			isPersistedAutoResolution(entry.data)
		) {
			selected = true
		} else if (entry.type === "model_change") {
			selected = isAutoModel({ provider: entry.provider, id: entry.modelId })
		}
	}
	return selected
}

type EffectiveModelContext<TApi extends string> = Pick<ExtensionContext, "sessionManager"> & {
	model: Model<TApi> | undefined
}

/**
 * Returns the concrete model that handles requests for this extension context.
 *
 * Extensions should use this instead of reading `ctx.model` when their behavior
 * depends on model identity or capabilities. After Auto routes a session,
 * `ctx.model` intentionally remains the user-selected `kimchi-dev/auto` model;
 * its concrete target is stored separately in that session's routing state.
 * Accepting the context keeps the selected model paired with its owning session
 * and avoids accidentally resolving Auto against another session.
 *
 * Use {@link resolveEffectiveModel} only at integration boundaries that do not
 * receive an `ExtensionContext`.
 */
export function getEffectiveModel<TApi extends string>(ctx: EffectiveModelContext<TApi>): Model<TApi> | undefined {
	if (!isAutoModel(ctx.model)) return ctx.model
	return resolveEffectiveModel(ctx.model, ctx.sessionManager.getSessionId())
}

/**
 * `auto (<model id>)` label for the resolved v1 Auto router pick.
 *
 * @deprecated use {@link formatRoutedModelLabel} with the requested virtual id
 *   so any backend-routed model renders correctly.
 */
export function formatAutoModelLabel(modelId: string): string {
	return formatRoutedModelLabel("auto", modelId)
}

/**
 * `<requested id> (<routed model id>)` label for a resolved backend-routed
 * model pick, shared by the prompt summary's model row (and any other surface
 * that labels a concrete pick). `prefix` is the requested (virtual) id — the
 * harness keeps requesting that id while displaying the routed pick.
 */
export function formatRoutedModelLabel(prefix: string, modelId: string): string {
	return `${prefix} (${modelId})`
}

/**
 * Whether the given model is a backend-routed virtual model with a resolved
 * concrete pick in this session.
 *
 * Id-agnostic: covers v1 `auto` (legacy state / `requestedId` "auto") and any
 * other backend-routed virtual model that resolved via `setAutoRoutingState`.
 * Concrete models and unresolved virtual sessions return false.
 */
export function isRoutedModel(model: Pick<Model<string>, "id" | "provider"> | undefined, sessionId: string): boolean {
	if (!model) return false
	const state = getAutoRoutingState(sessionId)
	if (state.status !== "resolved") return false
	if (state.requestedId !== undefined) return state.requestedId === model.id
	// Legacy v1 resolved state has no requestedId — only matches v1 `auto`.
	return isAutoModel(model)
}

/** Low-level resolver for integration boundaries without an extension context.
 *
 * Returns the concrete model that handles requests for this session when the
 * given `model` matches the requested id of a resolved routing state, and the
 * input `model` otherwise. Any backend-routed virtual model resolves so long
 * as its per-session routing state is populated and its id matches the state's
 * `requestedId`; legacy v1 state carries no `requestedId` and falls back to the
 * v1 `isAutoModel` guard.
 */
export function resolveEffectiveModel<TApi extends string>(
	model: Model<TApi> | undefined,
	sessionId: string,
): Model<TApi> | undefined {
	if (!model) return model
	const state = getAutoRoutingState(sessionId)
	if (state.status !== "resolved") return model
	// Id-agnostic: resolve when this model is the requested virtual id of the
	// resolved routing state. Legacy v1 state (and persisted hydration) carries
	// no `requestedId` — fall back to the v1 `isAutoModel` guard so behavior is
	// unchanged for Auto sessions.
	if (state.requestedId !== undefined) {
		return state.requestedId === model.id ? (state.model as Model<TApi>) : model
	}
	return isAutoModel(model) ? (state.model as Model<TApi>) : model
}

export function isPersistedAutoResolution(data: unknown): data is PersistedAutoResolution {
	return (
		data !== null &&
		typeof data === "object" &&
		"version" in data &&
		data.version === 1 &&
		"status" in data &&
		data.status === "resolved" &&
		"provider" in data &&
		typeof data.provider === "string" &&
		"modelId" in data &&
		typeof data.modelId === "string"
	)
}

export function hydrateAutoRoutingState(
	sessionId: string,
	entries: readonly SessionEntry[],
	modelRegistry: Pick<ModelRegistry, "find" | "getAvailable">,
): AutoRoutingState {
	const entry = entries.findLast(
		(candidate) =>
			candidate.type === "custom" &&
			candidate.customType === AUTO_RESOLUTION_ENTRY &&
			isPersistedAutoResolution(candidate.data),
	)
	const data = entry?.type === "custom" ? entry.data : undefined
	let state: AutoRoutingState = { status: "unresolved" }
	if (isPersistedAutoResolution(data)) {
		const model = modelRegistry.find(data.provider, data.modelId)
		const available = modelRegistry
			.getAvailable()
			.some((candidate) => candidate.provider === data.provider && candidate.id === data.modelId)
		state =
			model && available ? { status: "resolved", model } : { status: "failed", reason: "unavailable_recommendation" }
	}
	stateBySession.set(sessionId, state)
	return state
}

export function resolvedEntry(model: Pick<Model<string>, "provider" | "id">): PersistedAutoResolution {
	return { version: 1, status: "resolved", provider: model.provider, modelId: model.id }
}
