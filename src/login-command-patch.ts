/**
 * Patches the upstream pi SDK's `/login` slash command to offer Kimchi browser
 * authentication first, while preserving upstream subscription login.
 *
 * This module is imported for side effects. It must be loaded **before** any
 * `InteractiveMode` instance is constructed so the prototype patch takes effect.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	type AuthStatus,
	ExtensionSelectorComponent,
	InteractiveMode,
	OAuthSelectorComponent,
} from "@earendil-works/pi-coding-agent"
import { Spacer, Text } from "@earendil-works/pi-tui"
import { authenticateViaBrowser } from "./cli-auth/index.js"
import { writeApiKey } from "./config.js"
import type { PiModelConfig } from "./models.js"
import { syncProviderModels } from "./models.js"

const getPiModels = async () => {
	const piAi = await import("@earendil-works/pi-ai")
	return piAi.getModels
}

const KIMCHI_PROVIDER_ID = "kimchi-dev"
const KIMCHI_DEFAULT_MODEL_ID = "kimi-k2.6"
/**
 * Convert upstream Model to Kimchi PiModelConfig so we can persist subscription
 * provider models in Kimchi's models.json.
 */
function upstreamModelToPiConfig(m: Model<Api>, providerId: string) {
	return {
		id: m.id,
		name: m.name,
		api: m.api,
		baseUrl: m.baseUrl,
		reasoning: m.reasoning,
		input: m.input,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: m.cost,
		provider: providerId,
		compat: m.compat,
	}
}

/**
 * Pre-populate models.json with the subscription provider's built-in models.
 * This is necessary because `KIMCHI_DISABLE_BUILTIN_PROVIDERS` filters them
 * out of loadBuiltInModels(), so the only way upstream discovers them is
 * through models.json. Writing them before showLoginDialog ensures
 * completeProviderAuthentication() → refresh() sees them while auth is
 * already configured.
 */
async function prePopulateSubscriptionModels(providerId: string): Promise<void> {
	const getModels = await getPiModels()
	const piModels = getModels?.(providerId as unknown as Parameters<typeof getModels>[0]) ?? []
	if (piModels.length === 0) return

	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) {
		console.warn("KIMCHI_CODING_AGENT_DIR environment variable is missing. Models cannot be cached.")
		return
	}

	const modelsJsonPath = resolve(agentDir, "models.json")
	const configs = piModels.map((m) => upstreamModelToPiConfig(m, providerId))
	const firstModel = piModels[0]
	syncProviderModels(modelsJsonPath, providerId, configs as PiModelConfig[], {
		api: firstModel.api,
		baseUrl: firstModel.baseUrl,
	})
}

const KIMCHI_ACCOUNT_LABEL = "Use a Kimchi account"
const SUBSCRIPTION_LABEL = "Use a subscription"

// ---------------------------------------------------------------------------
// Intercept the upstream login flow to add the Kimchi browser auth choice
// ---------------------------------------------------------------------------

interface AuthStorage {
	set(provider: string, credential: unknown): void
	get(provider: string): unknown
}

interface ModelLike {
	id: string
	provider: string
}

interface ModelRegistry {
	authStorage: AuthStorage
	refresh(): void
	getAvailable(): ModelLike[]
	getModelById(id: string): ModelLike | undefined
	getProviderAuthStatus(providerId: string): AuthStatus
}

interface SessionLike {
	modelRegistry: ModelRegistry
	setModel(model: ModelLike): Promise<void>
}

type ChatContainerLike = {
	addChild(child: unknown): void
}

type UiLike = {
	requestRender(): void
}

type SelectorResult = { component: unknown; focus?: unknown }
type ShowSelector = (build: (done: () => void) => SelectorResult) => void
type AuthSelectorProvider = ConstructorParameters<typeof OAuthSelectorComponent>[2][number]
type OAuthSelectorAuthStorage = ConstructorParameters<typeof OAuthSelectorComponent>[1]

type LoginModeLike = {
	showSelector?: ShowSelector
	showStatus?: (msg: string) => void
	showLoginDialog?: (providerId: string, providerName: string) => Promise<void>
	getLoginProviderOptions?: (authType: "oauth" | "api_key") => AuthSelectorProvider[]
	session: SessionLike
	ui?: UiLike
}

/**
 * Add a standalone chat line that is not merged with upstream status lines.
 *
 * NOTE: This accesses undocumented upstream internals (`chatContainer`, `ui`).
 * If upstream renames these, the guard below causes a silent no-op rather than
 * a crash. Pin the upstream dependency version when bumping to catch breakage.
 */
function addLoginFeedback(im: InteractiveMode, text: string): void {
	const modeLike = im as unknown as { chatContainer: ChatContainerLike; ui: UiLike }
	const container = modeLike.chatContainer
	const ui = modeLike.ui
	if (!container) {
		// Upstream internals missing — fall back gracefully without crashing
		return
	}
	container.addChild(new Spacer(1))
	container.addChild(new Text(text, 1, 0))
	container.addChild(new Spacer(1))
	ui?.requestRender()
}

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype mutation
const imProto = InteractiveMode.prototype as any

/**
 * Mutable delegate for the original upstream showOAuthSelector.
 * Exposed as a writable object property so tests can stub the logout
 * delegation path without relying on ESM live-binding reassignment.
 */
export const oauthDelegate = {
	// biome-ignore lint/suspicious/noExplicitAny: `this` context type for upstream prototype method is unknown
	original: imProto.showOAuthSelector as (this: any, mode: "login" | "logout") => Promise<void>,
}

/** Exported for testing: applies the prototype patch (idempotent re-apply is safe). */
export function applyLoginCommandPatch(): void {
	imProto.showOAuthSelector = patchedShowOAuthSelector
}

async function handleKimchiLogin(im: InteractiveMode): Promise<void> {
	const modeLike = im as unknown as { showStatus?: (msg: string) => void; session: SessionLike }
	const showStatus = modeLike.showStatus?.bind(modeLike)
	const showError = im.showError.bind(im)

	let browserUrl: string | undefined
	try {
		showStatus?.("Opening browser for Kimchi login...")

		const { token } = await authenticateViaBrowser({
			onBrowserUrl: (url) => {
				browserUrl = url
			},
		})

		// Persist to Kimchi config
		writeApiKey(token)

		// Update the running session's auth storage
		const session = modeLike.session
		const registry = session?.modelRegistry
		if (registry) {
			registry.authStorage.set(KIMCHI_PROVIDER_ID, {
				type: "api_key",
				key: token,
			})
			registry.refresh()

			const availableModels = registry.getAvailable()
			const providerModels = availableModels.filter((m) => m.provider === KIMCHI_PROVIDER_ID)
			if (providerModels.length > 0) {
				const selectedModel = providerModels.find((m) => m.id === KIMCHI_DEFAULT_MODEL_ID) ?? providerModels[0]
				await session.setModel(selectedModel)
				addLoginFeedback(im, `✓ Logged in. Model: ${selectedModel.id}`)
			} else {
				addLoginFeedback(im, "✓ Login successful. API key saved.")
			}
		} else {
			addLoginFeedback(im, "✓ Login successful. API key saved.")
		}
	} catch (error) {
		if (browserUrl) {
			addLoginFeedback(im, `Couldn't open browser automatically. Visit: ${browserUrl}`)
		}
		showError(`Kimchi login failed: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function showSubscriptionLogin(im: InteractiveMode): void {
	const modeLike = im as unknown as LoginModeLike
	if (
		!modeLike.showSelector ||
		!modeLike.getLoginProviderOptions ||
		!modeLike.showLoginDialog ||
		!modeLike.session?.modelRegistry
	) {
		void oauthDelegate.original.call(im, "login")
		return
	}

	const registry = modeLike.session.modelRegistry
	const providerOptions = modeLike
		.getLoginProviderOptions("oauth")
		.filter((provider) => provider.id !== KIMCHI_PROVIDER_ID)
	if (providerOptions.length === 0) {
		modeLike.showStatus?.("No subscription providers available.")
		return
	}

	modeLike.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			"login",
			registry.authStorage as OAuthSelectorAuthStorage,
			providerOptions,
			async (providerId) => {
				done()
				const providerOption = providerOptions.find((provider) => provider.id === providerId)
				if (!providerOption) return

				try {
					// Pre-populate models.json before upstream login so that when
					// upstream calls completeProviderAuthentication → refresh() the
					// subscription models are already discoverable through models.json.
					await prePopulateSubscriptionModels(providerOption.id)

					await modeLike.showLoginDialog?.(providerOption.id, providerOption.name)

					// After upstream login returns, refresh the registry so the models
					// from models.json become available without requiring a manual /reload.
					const registry = modeLike.session?.modelRegistry
					if (registry && typeof registry.refresh === "function") {
						try {
							registry.refresh()
						} catch {
							// Silent — the next manual /reload or restart will pick up the models.
						}
					}
				} catch (error) {
					im.showError(`Subscription login failed: ${error instanceof Error ? error.message : String(error)}`)
				}
			},
			() => {
				done()
				showLoginChoiceSelector(im)
			},
			(providerId) => registry.getProviderAuthStatus(providerId),
		)
		return { component: selector, focus: selector }
	})
}

function showLoginChoiceSelector(im: InteractiveMode): void {
	const modeLike = im as unknown as LoginModeLike
	if (!modeLike.showSelector) {
		void handleKimchiLogin(im)
		return
	}

	modeLike.showSelector((done) => {
		const selector = new ExtensionSelectorComponent(
			"Select authentication method:",
			[KIMCHI_ACCOUNT_LABEL, SUBSCRIPTION_LABEL],
			(option) => {
				done()
				if (option === SUBSCRIPTION_LABEL) {
					showSubscriptionLogin(im)
					return
				}
				void handleKimchiLogin(im)
			},
			() => {
				done()
				modeLike.ui?.requestRender()
			},
		)
		return { component: selector, focus: selector }
	})
}

async function patchedShowOAuthSelector(this: InteractiveMode, mode: "login" | "logout") {
	if (mode === "login") {
		showLoginChoiceSelector(this)
		return
	}
	return oauthDelegate.original.call(this, mode)
}

// Apply patch on module load
applyLoginCommandPatch()
