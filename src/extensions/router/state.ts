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
	| { status: "resolved"; model: Model<string> }
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

/** Low-level Auto resolver for integration boundaries without an extension context. */
export function resolveEffectiveModel<TApi extends string>(
	model: Model<TApi> | undefined,
	sessionId: string,
): Model<TApi> | undefined {
	if (!isAutoModel(model)) return model
	const state = getAutoRoutingState(sessionId)
	return state.status === "resolved" ? (state.model as Model<TApi>) : model
}

function isPersistedAutoResolution(data: unknown): data is PersistedAutoResolution {
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
