/**
 * Patches the upstream pi SDK's `/login` slash command to offer Kimchi browser
 * authentication first, while preserving upstream subscription login.
 *
 * This module is imported for side effects. It must be loaded **before** any
 * `InteractiveMode` instance is constructed so the prototype patch takes effect.
 */

import { type AuthStatus, InteractiveMode, OAuthSelectorComponent } from "@earendil-works/pi-coding-agent"
import { Spacer, Text } from "@earendil-works/pi-tui"
import {
	KIMCHI_DEFAULT_ENDPOINT,
	KIMCHI_PROVIDER_ID,
	createLoginChoiceSelector,
	formatBrowserLoginMessage,
	performKimchiApiKeyLogin,
	performKimchiBrowserLogin,
	prePopulateSubscriptionModels,
} from "./extensions/login/flow.js"

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
	showExtensionInput?: (title: string, placeholder?: string) => Promise<string | undefined>
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

export const warningDelegate = {
	// biome-ignore lint/suspicious/noExplicitAny: `this` context type for upstream prototype method is unknown
	original: imProto.showWarning as (this: any, warningMessage: string) => void,
}

/** Exported for testing: applies the prototype patch (idempotent re-apply is safe). */
export function applyLoginCommandPatch(): void {
	imProto.showOAuthSelector = patchedShowOAuthSelector
	imProto.showWarning = patchedShowWarning
}

async function handleKimchiLogin(im: InteractiveMode): Promise<void> {
	const modeLike = im as unknown as { showStatus?: (msg: string) => void; session: SessionLike }
	const showStatus = modeLike.showStatus?.bind(modeLike)
	const showError = im.showError.bind(im)
	const session = modeLike.session
	const registry = session?.modelRegistry
	if (!registry) {
		showError("Kimchi login failed: model registry is unavailable")
		return
	}

	await performKimchiBrowserLogin({
		modelRegistry: registry,
		setModel: (model) => session.setModel(model),
		showStatus,
		showError,
		addFeedback: (message) => addLoginFeedback(im, message),
		// Surface the generated browser-login URL in the TUI. The auto-open can land
		// in the wrong browser or Chrome profile (and still "succeed"), so the user
		// needs the URL to copy into the right one. console.log is swallowed under the TUI.
		onBrowserUrl: (url) => addLoginFeedback(im, formatBrowserLoginMessage(url)),
	})
}

async function handleKimchiApiKeyLogin(im: InteractiveMode): Promise<void> {
	const modeLike = im as unknown as LoginModeLike
	const showStatus = modeLike.showStatus?.bind(modeLike)
	const showError = im.showError.bind(im)
	const session = modeLike.session
	const registry = session?.modelRegistry
	if (!registry) {
		showError("Kimchi API-key login failed: model registry is unavailable")
		return
	}
	if (!modeLike.showExtensionInput) {
		showError("Kimchi API-key login failed: text input is unavailable")
		return
	}

	const apiKey = await modeLike.showExtensionInput("Kimchi API Key:", "Enter your Kimchi API key")
	if (apiKey === undefined) return
	const endpointInput = await modeLike.showExtensionInput(
		`Kimchi endpoint (press Enter to use ${KIMCHI_DEFAULT_ENDPOINT}):`,
		"",
	)
	if (endpointInput === undefined) return

	await performKimchiApiKeyLogin(
		{
			modelRegistry: registry,
			setModel: (model) => session.setModel(model),
			showStatus,
			showError,
			addFeedback: (message) => addLoginFeedback(im, message),
		},
		{
			apiKey,
			endpoint: endpointInput.trim() || KIMCHI_DEFAULT_ENDPOINT,
		},
	)
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
		const selector = createLoginChoiceSelector({
			onKimchiAccount: () => {
				done()
				void handleKimchiLogin(im)
			},
			onKimchiApiKey: () => {
				done()
				void handleKimchiApiKeyLogin(im)
			},
			onSubscription: () => {
				done()
				showSubscriptionLogin(im)
			},
			onCancel: () => {
				done()
				modeLike.ui?.requestRender()
			},
		})
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

function patchedShowWarning(this: InteractiveMode, warningMessage: string): void {
	if (warningMessage.startsWith("No models available.") && hasModelsAfterStartupAuth(this)) {
		return
	}
	warningDelegate.original.call(this, warningMessage)
}

function hasModelsAfterStartupAuth(im: InteractiveMode): boolean {
	const modeLike = im as unknown as {
		session?: { model?: unknown; modelRegistry?: { getAvailable?: () => unknown[] } }
	}
	if (modeLike.session?.model) return true
	try {
		return (modeLike.session?.modelRegistry?.getAvailable?.().length ?? 0) > 0
	} catch {
		return false
	}
}

// Apply patch on module load
applyLoginCommandPatch()
