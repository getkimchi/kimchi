import { existsSync } from "node:fs"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs, MULTI_MODEL_ID } from "../../cli-args.js"
import { readAutoDefaultApplied, writeAutoDefaultApplied } from "../../config.js"
import { getSettingsManager } from "../../settings-watcher.js"
import { setMultiModelEnabled } from "../multi-model.js"
import { clearAutoRoutingAttempt, registerAutoApiProvider, stageAutoRoutingAttempt } from "./api-provider.js"
import { shouldDefaultToAuto } from "./auto-default-gate.js"
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

type ModelCapabilities = Pick<Model<Api>, "reasoning" | "thinkingLevelMap" | "contextWindow" | "maxTokens">

function hasTargetCapabilities(autoModel: ModelCapabilities, target: ModelCapabilities): boolean {
	return (
		autoModel.reasoning === target.reasoning &&
		autoModel.thinkingLevelMap === target.thinkingLevelMap &&
		autoModel.contextWindow === target.contextWindow &&
		autoModel.maxTokens === target.maxTokens
	)
}

function autoModelForTarget<TApi extends Api>(autoModel: Model<TApi>, target: ModelCapabilities): Model<TApi> {
	return {
		...autoModel,
		reasoning: target.reasoning,
		thinkingLevelMap: target.thinkingLevelMap,
		contextWindow: target.contextWindow,
		maxTokens: target.maxTokens,
	}
}

async function syncAutoCapabilities<TApi extends Api>(
	pi: ExtensionAPI,
	autoModel: Model<TApi>,
	target: ModelCapabilities,
): Promise<boolean> {
	if (hasTargetCapabilities(autoModel, target)) return true
	return pi.setModel(autoModelForTarget(autoModel, target))
}

/**
 * Whether a default model is saved in settings.json, concrete or Auto.
 *
 * Used to keep a saved default from being wrapped in multi-model mode. It
 * deliberately does not gate the Auto default: login and Ctrl+P cycling both
 * persist a default too, so most accounts carry one without ever having chosen
 * it.
 */
function hasPersistedDefault(): boolean {
	return !!getSettingsManager()?.getDefaultModel()
}

/**
 * Whether this session should have Auto installed as the default model.
 *
 * True at most once per install: `commit` records the change in settings.json
 * next to `defaultModel`, so a later switch away is never undone. Commitment is
 * separate from eligibility on purpose — recording it up front would
 * permanently skip an install whose Auto model could not be resolved (a failed
 * registration, an unavailable catalogue), leaving it without the default and
 * without any explanation.
 */
async function resolveAutoDefault(): Promise<{ eligible: boolean; commit: () => void }> {
	if (!(await shouldDefaultToAuto())) return { eligible: false, commit: () => {} }
	if (readAutoDefaultApplied()) return { eligible: false, commit: () => {} }
	return { eligible: true, commit: () => writeAutoDefaultApplied(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID) }
}

export interface AutoModelExtensionOptions {
	/** Require a vision-capable recommendation for context forwarded as image paths. */
	requiresVision?: boolean
	/** Apply main-session defaults and CLI choices; leave child model selection to the caller. */
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
			const sessionFile = ctx.sessionManager.getSessionFile()
			const hasPersistedSession = sessionFile !== undefined && existsSync(sessionFile)
			const cliOptions = options.handleCliModelSelection ? getParsedCliArgs().options : undefined
			const requestedModel = event.reason === "startup" ? cliOptions?.model : undefined
			if (
				requestedModel &&
				requestedModel !== MULTI_MODEL_ID &&
				ctx.model &&
				(isAutoModel(ctx.model) || sessionSelectsAuto(entries))
			) {
				setMultiModelEnabled(sessionId, false)
				// kimchi-dev: explicit CLI --model/--provider choice is user-initiated;
				// persist it as the default (0.84.1 semantics - upstream 0.85.1 made
				// setModel session-only by default).
				await pi.setModel(ctx.model, { persist: true })
				if (!isAutoModel(ctx.model)) {
					clearAutoRoutingState(sessionId)
					return
				}
			}
			let autoModel = ctx.model
			const freshSession =
				event.reason === "new" ||
				(event.reason === "startup" &&
					!event.previousSessionFile &&
					!hasPersistedSession &&
					!entries.some((entry) => entry.type === "message"))
			const explicitLaunchChoice =
				event.reason === "startup" &&
				(cliOptions?.model || cliOptions?.provider || cliOptions?.["multi-model"] || cliOptions?.models)
			// The main session opening a new conversation with no model named on the
			// command line: the only moment a saved default may be installed or
			// applied. Subagents are excluded so a child never rewrites the global
			// default, and a resumed conversation keeps the model it was using.
			const mainFreshLaunch = !!options.handleCliModelSelection && freshSession && !explicitLaunchChoice
			// Auto is installed as the default once per install, tracked by the
			// `autoDefaultApplied` marker in settings.json. Resolving it is a
			// network lookup, so it is reached only when the launch could actually
			// use the answer.
			const autoDefault = mainFreshLaunch && !isAutoModel(autoModel) ? await resolveAutoDefault() : undefined
			if (autoDefault?.eligible) {
				autoModel = ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID) ?? autoModel
				// `find` can come back empty (Auto unregistered, catalogue
				// unavailable), leaving the concrete model in place. Commit only
				// once Auto is genuinely in hand, or the install would be marked
				// done while still on its old model, with no retry.
				if (isAutoModel(autoModel)) {
					autoDefault.commit()
					setMultiModelEnabled(sessionId, false)
					// This replaces a model the user may have been using for a
					// while. Say so: a silent switch reads as a bug, and the marker
					// can be lost (settings reset, new machine), so the notice is
					// what keeps a repeat install merely mildly annoying.
					ctx.ui.notify("Auto is now the default model.", "info")
				}
			} else if (mainFreshLaunch && hasPersistedDefault()) {
				// Every launch after the first. A saved default outranks the global
				// multi-model default, whether it is concrete or Auto: without this
				// the session comes up as multi-model wrapping the saved model
				// rather than the model itself.
				setMultiModelEnabled(sessionId, false)
			}
			if (!isAutoModel(autoModel)) {
				if (!sessionSelectsAuto(entries)) {
					clearAutoRoutingState(sessionId)
					return
				}
				autoModel = ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID)
				if (!autoModel) {
					clearAutoRoutingState(sessionId)
					return
				}
			}
			setMultiModelEnabled(sessionId, false)
			const state = hydrateAutoRoutingState(sessionId, entries, ctx.modelRegistry)
			const sessionAutoModel = state.status === "resolved" ? autoModelForTarget(autoModel, state.model) : autoModel
			const currentModel = ctx.model
			if (
				!currentModel ||
				!isAutoModel(currentModel) ||
				(state.status === "resolved" && !hasTargetCapabilities(currentModel, state.model))
			) {
				await pi.setModel(sessionAutoModel)
			}
		})

		pi.on("model_select", async (event, ctx) => {
			if (!isAutoModel(event.model)) return
			const sessionId = ctx.sessionManager.getSessionId()
			let state = getAutoRoutingState(sessionId)
			if (state.status === "unresolved") {
				state = hydrateAutoRoutingState(sessionId, ctx.sessionManager.getEntries(), ctx.modelRegistry)
			}
			if (state.status !== "resolved") return
			await syncAutoCapabilities(pi, event.model, state.model)
		})

		pi.on("input", (event, ctx) => {
			if (!isAutoModel(ctx.model) || !event.images?.length) return
			const state = getAutoRoutingState(ctx.sessionManager.getSessionId())
			if (state.status !== "resolved" || state.model.input.includes("image")) return
			ctx.ui.notify(
				"Auto cannot process images in this session. Select a vision model with /model, or use /strip-images for existing images.",
				"warning",
			)
			return { action: "handled" }
		})

		pi.on("before_agent_start", (event, ctx) => {
			const autoModel = ctx.model
			if (!isAutoModel(autoModel)) return
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

			stageAutoRoutingAttempt(sessionId, async ({ signal, headers }) => {
				const fail = (reason: AutoFailureReason): Extract<AutoRoutingState, { status: "failed" }> => {
					setAutoRoutingState(sessionId, { status: "unresolved" })
					return { status: "failed", reason }
				}

				const query = await prepareRouterQuery(event.prompt, { containsImages: requiresVision })
				if (!query.ok) return fail(query.reason)

				let config: RouterConfig | undefined
				try {
					config = await getRouterConfig(ctx.modelRegistry)
				} catch {
					config = undefined
				}
				if (!config) return fail("no_auth")

				const route = await routeQuery(query.query, config, { signal, headers })
				if (!route.ok) return fail(routeFailureReason(route.reason))

				const resolution = resolveRecommendation(route.recommendation, ctx, requiresVision)
				if (!resolution.ok) return fail(resolution.reason)
				if (!(await syncAutoCapabilities(pi, autoModel, resolution.model))) {
					return fail("model_update_failed")
				}

				const state = { status: "resolved", model: resolution.model } satisfies AutoRoutingState
				setAutoRoutingState(sessionId, state)
				pi.appendEntry(AUTO_RESOLUTION_ENTRY, resolvedEntry(resolution.model))
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
