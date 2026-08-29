import type { ExtensionAPI, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs, MULTI_MODEL_ID } from "../../cli-args.js"
import { setMultiModelEnabled } from "../multi-model.js"
import { clearAutoRoutingAttempt, registerAutoApiProvider, stageAutoRoutingAttempt } from "./api-provider.js"
import { AUTO_MODEL_ID, AUTO_MODEL_PROVIDER, isAutoModel } from "./constants.js"
import { routeQuery } from "./router-client.js"
import { getRouterConfig, type RouterConfig } from "./router-config.js"
import { prepareRouterQuery } from "./router-query.js"
import { resolveRecommendation } from "./selection.js"
import {
	AUTO_RESOLUTION_ENTRY,
	type AutoFailureReason,
	type AutoRoutingState,
	clearAutoRoutingState,
	getAutoRoutingState,
	hydrateAutoRoutingState,
	resolvedEntry,
	sessionSelectsAuto,
	setAutoRoutingState,
} from "./state.js"

function branchHasImages(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "toolResult") &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some((content) => content.type === "image"),
	)
}

function routeFailureReason(reason: "cancelled" | "timeout" | "network" | "http" | "malformed"): AutoFailureReason {
	return reason === "http" ? "router_http" : reason
}

export interface AutoModelExtensionOptions {
	/** Require a vision-capable recommendation for context forwarded as image paths. */
	requiresVision?: boolean
	/** Record main-process CLI model choices before restoring saved Auto state. */
	handleCliModelSelection?: boolean
}

export function createAutoModelExtension(options: AutoModelExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// Pi clears custom API handlers on /reload, so register with each extension lifecycle.
		registerAutoApiProvider()

		pi.on("session_start", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			clearAutoRoutingAttempt(sessionId)
			const entries = ctx.sessionManager.getEntries()
			const requestedModel =
				event.reason === "startup" && options.handleCliModelSelection ? getParsedCliArgs().options.model : undefined
			if (
				requestedModel &&
				requestedModel !== MULTI_MODEL_ID &&
				ctx.model &&
				(isAutoModel(ctx.model) || sessionSelectsAuto(entries))
			) {
				setMultiModelEnabled(sessionId, false)
				await pi.setModel(ctx.model)
				if (!isAutoModel(ctx.model)) {
					clearAutoRoutingState(sessionId)
					return
				}
			}
			if (!isAutoModel(ctx.model)) {
				if (!sessionSelectsAuto(entries)) {
					clearAutoRoutingState(sessionId)
					return
				}
				const autoModel = ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID)
				if (!autoModel) {
					clearAutoRoutingState(sessionId)
					return
				}
				await pi.setModel(autoModel)
			}
			setMultiModelEnabled(sessionId, false)
			hydrateAutoRoutingState(sessionId, entries, ctx.modelRegistry)
		})

		pi.on("input", (event, ctx) => {
			if (!isAutoModel(ctx.model) || !event.images?.length) return
			const state = getAutoRoutingState(ctx.sessionManager.getSessionId())
			if (state.status !== "resolved" || state.model.input.includes("image")) return
			ctx.ui.notify(
				`Auto resolved to ${state.model.provider}/${state.model.id}, which does not support images. Select a vision model with /model, or use /strip-images for existing images.`,
				"warning",
			)
			return { action: "handled" }
		})

		pi.on("before_agent_start", (event, ctx) => {
			if (!isAutoModel(ctx.model)) return
			const sessionId = ctx.sessionManager.getSessionId()
			if (getAutoRoutingState(sessionId).status === "unresolved") {
				hydrateAutoRoutingState(sessionId, ctx.sessionManager.getEntries(), ctx.modelRegistry)
			}
			if (getAutoRoutingState(sessionId).status !== "unresolved") return

			setAutoRoutingState(sessionId, { status: "attempting" })

			const requiresVision =
				options.requiresVision === true ||
				Boolean(event.images?.length) ||
				branchHasImages(ctx.sessionManager.getBranch())

			stageAutoRoutingAttempt(sessionId, async (signal) => {
				const fail = (reason: AutoFailureReason): Extract<AutoRoutingState, { status: "failed" }> => {
					setAutoRoutingState(sessionId, { status: "unresolved" })
					return { status: "failed", reason }
				}

				const query = await prepareRouterQuery(event.prompt)
				if (!query.ok) return fail(query.reason)

				let config: RouterConfig | undefined
				try {
					config = await getRouterConfig(ctx.modelRegistry)
				} catch {
					config = undefined
				}
				if (!config) return fail("no_auth")

				const route = await routeQuery(query.query, config, { signal })
				if (!route.ok) return fail(routeFailureReason(route.reason))

				const resolution = resolveRecommendation(route.recommendation, ctx, requiresVision)
				if (!resolution.ok) return fail(resolution.reason)

				const state = { status: "resolved", model: resolution.model } satisfies AutoRoutingState
				setAutoRoutingState(sessionId, state)
				pi.appendEntry(AUTO_RESOLUTION_ENTRY, resolvedEntry(resolution.model))
				ctx.ui.notify(`Auto selected ${resolution.model.provider}/${resolution.model.id} for this session`, "info")
				return state
			})
		})

		pi.on("session_shutdown", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			clearAutoRoutingAttempt(sessionId)
			clearAutoRoutingState(sessionId)
		})
	}
}

const autoModelExtension = createAutoModelExtension({ handleCliModelSelection: true })

export default autoModelExtension
