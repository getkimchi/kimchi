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
 * Mutable delegate for the original upstream handleLoginCommand.
 * Exposed as a writable object property so tests can stub the delegation
 * path (e.g. `/login <provider>`) without relying on ESM live-binding
 * reassignment.
 */
export const handleLoginDelegate = {
	// biome-ignore lint/suspicious/noExplicitAny: `this` context type for upstream prototype method is unknown
	original: imProto.handleLoginCommand as (this: any, providerRef?: string) => Promise<void>,
}

export const warningDelegate = {
	// biome-ignore lint/suspicious/noExplicitAny: `this` context type for upstream prototype method is unknown
	original: imProto.showWarning as (this: any, warningMessage: string) => void,
}

/**
 * Validate that upstream still exposes the methods this patch depends on, then
 * install the overrides. Exported for testing; idempotent re-apply is safe.
 *
 * The check covers the methods we override (handleLoginCommand, showWarning) plus
 * the internals the bespoke menu *calls* at runtime — those are otherwise guarded
 * with silent fallbacks, so a rename would only break a menu action when the user
 * clicks it. Missing any of them throws, crashing at startup (consistent with the
 * other pi patches) so a silently-broken Kimchi `/login` can't ship.
 *
 * NOTE: this cannot detect upstream *relocating the call site* off a still-present
 * method (exactly how the 0.80 bump slipped through: `/login` stopped calling the
 * patched showOAuthSelector). A bump-time `/verify` of `/login` is the guard for that.
 */
export function applyLoginCommandPatch(): void {
	const required = [
		"handleLoginCommand",
		"showWarning",
		"showSelector",
		"getLoginProviderOptions",
		"showLoginDialog",
		"showExtensionInput",
	] as const
	const missing = required.filter((name) => typeof imProto[name] !== "function")
	if (missing.length > 0) {
		throw new Error(
			`Kimchi login patch: upstream InteractiveMode is missing expected method(s): ${missing.join(", ")}. The pinned @earendil-works/pi-coding-agent version likely refactored the login flow; update src/login-command-patch.ts to match the new entry points.`,
		)
	}
	imProto.handleLoginCommand = patchedHandleLoginCommand
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
		// Guards failed (upstream internals moved) — fall back to upstream's native
		// login menu rather than silently doing nothing. Uses the *original*
		// handleLoginCommand (not the patched one) to avoid re-entering this menu.
		void handleLoginDelegate.original.call(im, undefined)
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

async function patchedHandleLoginCommand(this: InteractiveMode, providerRef?: string) {
	// Upstream routes a bare `/login` through handleLoginCommand → showLoginAuthTypeSelector
	// (this replaced the older showOAuthSelector("login") entry point in pi 0.80). Intercept
	// only the argument-less form so the Kimchi choice menu appears; `/login <provider>`
	// keeps upstream's direct-provider path.
	if (!providerRef) {
		showLoginChoiceSelector(this)
		return
	}
	return handleLoginDelegate.original.call(this, providerRef)
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
