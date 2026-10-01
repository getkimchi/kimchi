import type { Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "./constants.js"

export type AutoRoutingState =
	| { status: "unresolved" }
	| { status: "resolved"; model: Model<string>; requestedId: string }

const stateBySession = new Map<string, AutoRoutingState>()

export function getAutoRoutingState(sessionId: string | undefined): AutoRoutingState {
	if (!sessionId) return { status: "unresolved" }
	return stateBySession.get(sessionId) ?? { status: "unresolved" }
}

export function setAutoRoutingState(sessionId: string, state: AutoRoutingState): void {
	stateBySession.set(sessionId, state)
}

export function clearAutoRoutingState(sessionId: string): void {
	stateBySession.delete(sessionId)
}

type EffectiveModelContext<TApi extends string> = Pick<ExtensionContext, "sessionManager"> & {
	model: Model<TApi> | undefined
}

/**
 * Concrete model handling requests for this context: `ctx.model` stays the
 * selected virtual id on routed sessions, so behavior that depends on model
 * identity resolves the pick through the session's routing state.
 */
export function getEffectiveModel<TApi extends string>(ctx: EffectiveModelContext<TApi>): Model<TApi> | undefined {
	if (!ctx.model || !isAutoRoutedModel(ctx.model)) return ctx.model
	return resolveEffectiveModel(ctx.model, ctx.sessionManager.getSessionId())
}

/** `<requested id> (<routed model id>)` display label for a resolved pick. */
export function formatRoutedModelLabel(prefix: string, modelId: string): string {
	return `${prefix} (${modelId})`
}

/** Whether `model` is the routed virtual model selected in this session. */
export function isRoutedModel(model: Pick<Model<string>, "id" | "provider"> | undefined, sessionId: string): boolean {
	if (!model) return false
	const state = getAutoRoutingState(sessionId)
	return state.status === "resolved" && state.requestedId === model.id
}

/** Resolver for boundaries without an extension context (see getEffectiveModel). */
export function resolveEffectiveModel<TApi extends string>(
	model: Model<TApi> | undefined,
	sessionId: string,
): Model<TApi> | undefined {
	if (!model) return model
	const state = getAutoRoutingState(sessionId)
	if (state.status !== "resolved") return model
	return state.requestedId === model.id ? (state.model as Model<TApi>) : model
}
