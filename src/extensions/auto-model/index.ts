import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { getParsedCliArgs } from "../../cli-args.js"
import { writeJson } from "../../config/json.js"
import { getAgentConfigDir } from "../../config.js"
import { readModelDeprecations } from "../../model-deprecation.js"
import { getSettingsManager } from "../../settings-watcher.js"
import { syncAutoCapabilities } from "./capabilities.js"
import { AUTO_MODEL_NAME, AUTO_MODEL_PROVIDER, GATED_DEFAULT_MODEL_CANDIDATES, isAutoRoutedModel } from "./constants.js"
import { type RoutedModelRegistry, type RoutedModelResolution, resolveRoutedModel } from "./routed-model.js"
import { clearAutoRoutingState, setAutoRoutingState } from "./state.js"

export const ROUTED_MODEL_RESOLUTION_ENTRY = "kimchi_routed_model_resolution"

/** Persisted in the session log so the pick notice survives resume and renders. */
type PersistedRoutedResolution = {
	version: 1
	requestedId: string
	provider: string
	modelId: string
	/** Concrete model's provider block when it differs from the requested one. */
	routedProvider?: string
}

/** Exported for the ACP routed-model mirror; the persisted shape is shared
 * wire-and-storage truth. */
export function isPersistedRoutedResolution(data: unknown): data is PersistedRoutedResolution {
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
		typeof data.modelId === "string" &&
		(!("routedProvider" in data) || typeof data.routedProvider === "string")
	)
}

/** A custom entry carrying a validated routed-resolution payload. */
type RoutedResolutionEntry = Extract<SessionEntry, { type: "custom" }> & {
	data: PersistedRoutedResolution
}

/** Match a routed-resolution entry in one step — type, customType, and payload
 * guard — so callers get validated `entry.data` without re-sequencing checks. */
export function isRoutedResolutionEntry(entry: SessionEntry): entry is RoutedResolutionEntry {
	return (
		entry.type === "custom" &&
		entry.customType === ROUTED_MODEL_RESOLUTION_ENTRY &&
		isPersistedRoutedResolution(entry.data)
	)
}

function routedEntry(resolution: RoutedModelResolution, requestedId: string): PersistedRoutedResolution {
	// `provider` stays the requested virtual provider: consumers compose the
	// requested ref from it. Only a pick served by a sibling block needs the
	// extra field, so base-block entries keep their existing shape for replay.
	const routedProvider = resolution.kind === "model" ? resolution.model.provider : undefined
	return {
		version: 1,
		requestedId,
		provider: AUTO_MODEL_PROVIDER,
		modelId: resolution.kind === "unknown" ? resolution.rawId : resolution.model.id,
		...(routedProvider && routedProvider !== AUTO_MODEL_PROVIDER ? { routedProvider } : {}),
	}
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

/**
 * The virtual id the backend owns as the product-level "Auto" default.
 * Catalog-driven: installed as the saved default only when the backend
 * actually advertises it. The rest of the extension stays id-agnostic.
 */
const DEFAULT_VIRTUAL_MODEL_ID = "auto"

/**
 * Drop the retired `autoDefaultApplied` marker from settings.json. Existing
 * installs still carry it, and harness settings writes merge onto the file,
 * so nothing else ever removes a key it no longer knows. Idempotent: a file
 * without the key is left untouched.
 */
function dropRetiredAutoDefaultMarker(): void {
	const path = resolve(getAgentConfigDir(), "settings.json")
	try {
		const settings: unknown = JSON.parse(readFileSync(path, "utf-8"))
		if (
			settings !== null &&
			typeof settings === "object" &&
			!Array.isArray(settings) &&
			"autoDefaultApplied" in settings
		) {
			const { autoDefaultApplied: _dropped, ...rest } = settings as Record<string, unknown>
			writeJson(path, rest)
		}
	} catch {
		// A missing or unreadable settings file needs no cleanup.
	}
}

/**
 * Remove defaultModel/defaultProvider from settings.json. Used when the saved
 * default resolves against nothing in the catalog and there is no catalog
 * model to fall forward to: the dead pointer is dropped. Idempotent;
 * a missing or unreadable file is left alone, and the write must never take
 * down session start (same guard as the seeded-default writes).
 */
function clearPersistedDefault(): void {
	const path = resolve(getAgentConfigDir(), "settings.json")
	try {
		const settings: unknown = JSON.parse(readFileSync(path, "utf-8"))
		if (settings !== null && typeof settings === "object" && !Array.isArray(settings)) {
			const { defaultModel: _model, defaultProvider: _provider, ...rest } = settings as Record<string, unknown>
			writeJson(path, rest)
		}
	} catch {
		// Nothing to clear.
	}
}

/**
 * Whether a default model is saved in settings.json, concrete or virtual.
 *
 * Decides whether a gated organization still owes its seeded default. It
 * deliberately does not gate the Auto default: login and Ctrl+P cycling both
 * persist a default too, so most accounts carry one without ever having chosen
 * it.
 */
function hasPersistedDefault(): boolean {
	return !!getSettingsManager()?.getDefaultModel()
}

/**
 * Metadata-declared successor for a dead catalog model: the deprecation
 * sidecar's `replacement_model`, then `alternatives` in order, each validated
 * against the live registry — a successor that is itself unserved is skipped.
 * The sidecar is a union-merge that keeps entries for models already removed
 * from the catalog, so the successor stays known after the model disappears.
 * Returns the first served candidate plus the deprecation note, if any.
 */
function findMetadataSuccessor(
	deadId: string,
	modelRegistry: RoutedModelRegistry & Pick<ExtensionContext["modelRegistry"], "hasConfiguredAuth">,
): { model: Model<Api>; note?: string } | undefined {
	const info = readModelDeprecations(resolve(getAgentConfigDir(), "models.json")).get(deadId)
	if (!info) return undefined
	const slugs = [info.replacement_model, ...(info.alternatives?.map((alternative) => alternative.slug) ?? [])]
	for (const slug of slugs) {
		// Successors can live on a sibling gateway block too, so resolve like a routed pick.
		const resolution = slug ? resolveRoutedModel(AUTO_MODEL_PROVIDER, slug, modelRegistry) : undefined
		if (resolution?.kind !== "model") continue
		// setModel gates on configured auth: a candidate from a block this machine
		// cannot authenticate (e.g. Codex without a ChatGPT login) would fail
		// silently and never reach the policy heirs. Treat it as unserved.
		if (!modelRegistry.hasConfiguredAuth(resolution.model)) continue
		return { model: resolution.model, note: info.deprecation_note }
	}
	return undefined
}

/** Whether the saved default itself is a routed virtual model (provider + auto* id). */
function persistedDefaultIsRoutedAuto(): boolean {
	const manager = getSettingsManager()
	if (!manager) return false
	return isAutoRoutedModel({ provider: manager.getDefaultProvider() ?? "", id: manager.getDefaultModel() ?? "" })
}

/**
 * Whether the session's persisted entries show the user's latest selection is
 * a routed virtual model. `model_change` entries match by the `auto*` prefix
 * on the kimchi-dev provider, and a routed resolution entry implies a virtual
 * selection as well. A later concrete `model_change` overrides earlier
 * entries.
 */
export function sessionSelectsRoutedAuto(entries: readonly SessionEntry[]): boolean {
	let selected = false
	for (const entry of entries) {
		// Presence only, deliberately without the payload guard: the entry's
		// existence evidences a routed selection even if its data is malformed
		// or written by a newer shape version.
		if (entry.type === "custom" && entry.customType === ROUTED_MODEL_RESOLUTION_ENTRY) {
			selected = true
		} else if (entry.type === "model_change") {
			selected = isAutoRoutedModel({ provider: entry.provider, id: entry.modelId })
		}
	}
	return selected
}

export interface AutoModelRoutingExtensionOptions {
	/** Apply main-session defaults and CLI choices; leave child model selection to the caller. */
	handleCliModelSelection?: boolean
}

export function createAutoModelRoutingExtension(options: AutoModelRoutingExtensionOptions = {}): ExtensionFactory {
	/**
	 * Learn the routed pick from a streamed/committed assistant message and, when
	 * it changed, announce it and re-sync capabilities. Fires from `message_update`
	 * (near stream-start) and from `message_end` as a fallback for responses that
	 * never streamed a `message_update` (e.g. non-streamed providers). Idempotent
	 * per pick via `lastNotifiedModel`.
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

		// The reported pick is the dedup key: both resolver branches return a model
		// whose id equals `responseModel`, so the catalog lookup can sit behind the
		// guard. `message_update` fires per streamed chunk and the sibling fallback
		// scans the whole catalog — resolving first would rescan per token.
		if (lastNotifiedModel.get(sessionId) === message.responseModel) return
		lastNotifiedModel.set(sessionId, message.responseModel)

		const resolution = resolveRoutedModel(message.provider, message.responseModel, ctx.modelRegistry)

		// Backend-reachable concrete model: record it and re-sync capabilities
		// to its real window/tokens so compaction and thinking controls match.
		// ctx.model is the requested virtual descriptor; copying it onto the
		// routed target's capabilities keeps the requested id honest while the
		// effective window drives context management.
		if (resolution.kind !== "unknown") {
			setAutoRoutingState(sessionId, { status: "resolved", model: resolution.model, requestedId: message.model })
			// Re-capability only the virtual model the request was made with. If
			// the selection changed before this handler runs, ctx.model is the new
			// concrete model and must not inherit the routed model's window:
			// setModel for the same id emits no model_select (modelsAreEqual), so
			// nothing would correct it afterwards. A switch landing during the
			// sync's own await inside setModel can still win — pre-existing window,
			// not widened here.
			if (ctx.model && ctx.model.id === message.model) {
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
			if (!isRoutedResolutionEntry(entry)) return undefined
			return new Text(theme.fg("dim", formatRoutedPickNotice(entry.data.requestedId, entry.data.modelId)), 0, 0)
		})

		// `message_update` fires from the first streamed chunk carrying `model`, so
		// the notice appears near stream-start rather than at turn-end.
		pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
			applyRoutedResolution(pi, event.message, ctx, ctx.sessionManager.getSessionId())
		})

		// Fallback for non-streamed responses that never emit `message_update`.
		pi.on("message_end", (event: MessageEndEvent, ctx) => {
			applyRoutedResolution(pi, event.message, ctx, ctx.sessionManager.getSessionId())
		})

		pi.on("session_start", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			const entries = ctx.sessionManager.getEntries()
			const cliOptions = options.handleCliModelSelection ? getParsedCliArgs().options : undefined
			const requestedModel = event.reason === "startup" ? cliOptions?.model : undefined

			// An explicit CLI `--model` over a routed-virtual default or session is
			// user-initiated: persist it as the default (0.84.1 semantics — upstream
			// 0.85.1 made setModel session-only by default). On a fresh startup the
			// CLI choice has already replaced the saved default in ctx.model, so the
			// persisted default is checked too. When the choice is concrete, stop
			// tracking the previous virtual pick.
			if (
				requestedModel &&
				ctx.model &&
				(isAutoRoutedModel(ctx.model) || sessionSelectsRoutedAuto(entries) || persistedDefaultIsRoutedAuto())
			) {
				await pi.setModel(ctx.model, { persist: true })
				if (!isAutoRoutedModel(ctx.model)) {
					clearAutoRoutingState(sessionId)
					resetLastNotified(sessionId)
					return
				}
			}

			// The main session opening a new conversation with no model named on the
			// command line is the only moment a saved default may be installed or
			// unwrapped. Subagents are excluded so a child never rewrites the global
			// default, and a resumed conversation keeps the model it was using.
			// A pre-created session file alone is not a resumed conversation: launch
			// wrappers may create one before startup, so freshness needs message content.
			const freshSession =
				event.reason === "new" ||
				(event.reason === "startup" && !event.previousSessionFile && !entries.some((entry) => entry.type === "message"))
			// An explicit CLI model belongs to this process, not only its startup event:
			// /new and /clear replace the session with reason "new" and keep it too.
			// Other launch options keep their existing startup-only exemption.
			const explicitLaunchChoice =
				event.reason === "startup" ? cliOptions?.model || cliOptions?.provider || cliOptions?.models : cliOptions?.model
			const mainFreshLaunch = !!options.handleCliModelSelection && freshSession && !explicitLaunchChoice

			if (options.handleCliModelSelection) dropRetiredAutoDefaultMarker()

			// Catalog-driven defaults — two policies, decided by what the
			// backend catalog serves:
			//
			// - Orgs served a routed virtual model (`auto`): Auto is
			//   EVER-RE-FORCED — a manual switch away is honoured for its
			//   session, but the next fresh session rolls back to Auto, because
			//   for entitled accounts Auto IS the default, not a one-time
			//   install. This applies whatever provider the session came up on —
			//   a switch to another provider's model (e.g. Anthropic's Claude)
			//   rolls back too. The rollback is announced: a silent switch away
			//   from a deliberately chosen model reads as a bug.
			// - Orgs NOT served `auto` are gated: a fresh session with no saved
			//   default gets a concrete flash model as the default, ONCE. A saved
			//   default (a deliberate pick, login or Ctrl+P) is respected, and
			//   session-level choices (resume, CLI flags) keep their precedence.
			//   When no flash candidate is served either, upstream's own initial
			//   model applies.
			const autoModel = ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, DEFAULT_VIRTUAL_MODEL_ID)
			const gatedDefault = autoModel
				? undefined
				: GATED_DEFAULT_MODEL_CANDIDATES.map((id) => ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, id)).find(
						(candidate) => candidate !== undefined,
					)
			// The gated default is owed only while no default is saved.
			const gatedDefaultOwed = !hasPersistedDefault()

			// Self-heal dead defaults. A persisted default the catalog no longer
			// serves (sunset, org de-list, rename) never resolves: upstream's
			// findInitialModel silently falls back to some provider default on
			// EVERY launch and leaves settings.json pointing at the dead entry
			// forever, with only a generic restore-failure notice. Instead, heal
			// once per fresh launch: re-derive the default with the metadata-declared
			// successor (sidecar, validated live) or the same catalog policy as
			// seeding (heir = Auto when served, else the first served flash
			// candidate, else the first served catalog model), persist it, and say
			// why. When not even the catalog can inherit, clear the dead pointer.
			// Detection runs on catalog membership only, so a
			// deprecated-but-served default is never healed away while the proxy
			// still translates it.
			const settingsManager = getSettingsManager()
			const persistedProvider = settingsManager?.getDefaultProvider()
			const persistedModelId = settingsManager?.getDefaultModel()
			// Heal candidates are kimchi-dev models, and routed virtual sentinels
			// are policy states (the Auto rollback owns them), not dead pointers — only a concrete kimchi-dev
			// default the catalog no longer serves is dead.
			const deadDefault =
				persistedProvider === AUTO_MODEL_PROVIDER &&
				persistedModelId !== undefined &&
				!persistedDefaultIsRoutedAuto() &&
				ctx.modelRegistry.find(persistedProvider, persistedModelId) === undefined
					? { provider: persistedProvider, id: persistedModelId }
					: undefined

			// Fresh main sessions: enforce the catalog-driven defaults policy
			// described above — Auto for entitled orgs, the gated flash model
			// (or nothing) for gated ones.
			if (mainFreshLaunch && (!ctx.model || !isAutoRoutedModel(ctx.model))) {
				// Installs the fresh-session default — the gated flash model or Auto —
				// and announces it. Persist: upstream 0.85.1 made setModel session-only
				// by default, and the notice claims a default-level change. Persisting
				// also means a resumed new session restores the default rather than
				// the model that was switched to. The rollback fires on every fresh
				// session after a deliberate switch, so the copy must read correctly on
				// the tenth repeat — state the policy and the escape hatch instead of
				// pretending this is a first-time install.
				const installFreshDefault = async (candidate: Model<Api>, displayName: string): Promise<void> => {
					await pi.setModel(candidate, { persist: true })
					resetLastNotified(sessionId)
					// Mode-neutral copy: this notice is also relayed to ACP clients
					// (Zed, Studio), where /model is not an available interaction.
					ctx.ui.notify(
						`New sessions start on ${displayName} (the default). To pick a different model for this session, use your client's model selector (/model in the terminal).`,
						"info",
					)
				}

				if (deadDefault) {
					// Heir priority: the metadata-declared successor (validated live)
					// beats the policy heirs — Auto, the gated flash candidate — and
					// finally the first served catalog model, which is exactly what
					// upstream's findInitialModel would silently pick on every launch;
					// the heal just makes that pick stable, persisted, and announced.
					const successor = findMetadataSuccessor(deadDefault.id, ctx.modelRegistry)
					const firstServed = ctx.modelRegistry.getAvailable().find((m) => m.provider === AUTO_MODEL_PROVIDER)
					const heir = successor?.model ?? autoModel ?? gatedDefault ?? firstServed
					resetLastNotified(sessionId)
					if (heir) {
						await pi.setModel(heir, { persist: true })
						const displayName = heir === autoModel ? AUTO_MODEL_NAME : heir.name
						const note = successor?.note ? ` Details: ${successor.note}` : ""
						// Mode-neutral copy: this notice is also relayed to ACP clients
						// (Zed, Studio), where /model is not an available interaction.
						ctx.ui.notify(
							`Default model "${deadDefault.id}" is no longer served and has been replaced. New sessions start on ${displayName} (the new default).${note} To pick a different model for this session, use your client's model selector (/model in the terminal).`,
							"info",
						)
					} else {
						// Zero catalog models to inherit: drop the dead pointer so
						// upstream's per-launch fallback stops resolving against it.
						// The org runs on the client's own fallback surface until a
						// model is served again.
						clearPersistedDefault()
						ctx.ui.notify(
							`Default model "${deadDefault.id}" is no longer served and has been cleared. To pick a model for this session, use your client's model selector (/model in the terminal).`,
							"info",
						)
					}
					return
				}

				if (!autoModel && gatedDefault) {
					// Gated organization: the guards below implement the ONE-TIME
					// migration policy described above (a completed migration is a
					// no-op; only Auto rolls back on every fresh session).
					if (!gatedDefaultOwed) {
						resetLastNotified(sessionId)
						return
					}
					// A session already on the gated default needs no churn: nothing is
					// re-installed or announced, so return early.
					const alreadyOnDefault =
						ctx.model !== undefined && ctx.model.provider === AUTO_MODEL_PROVIDER && ctx.model.id === gatedDefault.id
					if (alreadyOnDefault) {
						resetLastNotified(sessionId)
						return
					}
					await installFreshDefault(gatedDefault, gatedDefault.name)
					return
				}
				if (autoModel) {
					await installFreshDefault(autoModel, AUTO_MODEL_NAME)
					// A fresh session carries no routing state to hydrate; stop here.
					return
				}
			}

			if (!ctx.model || !isRoutableProvider(ctx.model)) {
				resetLastNotified(sessionId)
				return
			}
			const data = ctx.sessionManager.getEntries().findLast(isRoutedResolutionEntry)?.data
			if (!data || data.requestedId !== ctx.model.id) {
				resetLastNotified(sessionId)
				return
			}

			lastNotifiedModel.set(sessionId, data.modelId)
			const resolution = resolveRoutedModel(data.routedProvider ?? data.provider, data.modelId, ctx.modelRegistry)
			const concrete = resolution.kind === "model" ? resolution.model : undefined
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

const autoModelRoutingExtension = createAutoModelRoutingExtension({ handleCliModelSelection: true })

export default autoModelRoutingExtension
