import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { getModels } from "@earendil-works/pi-ai"
import {
	type AuthStatus,
	type ExtensionContext,
	ExtensionSelectorComponent,
	LoginDialogComponent,
	OAuthSelectorComponent,
} from "@earendil-works/pi-coding-agent"
import { type Component, Container, type TUI } from "@earendil-works/pi-tui"
import { authenticateViaBrowser } from "../../cli-auth/index.js"
import { loadConfig, writeApiKey } from "../../config.js"
import {
	ModelsFetchError,
	type PiModelConfig,
	isTransientModelsError,
	syncProviderModels,
	updateModelsConfig,
} from "../../models.js"

export const KIMCHI_PROVIDER_ID = "kimchi-dev"
export const KIMCHI_DEFAULT_MODEL_ID = "kimi-k2.6"
export const KIMCHI_ACCOUNT_LABEL = "Use a Kimchi account"
export const KIMCHI_API_KEY_LABEL = "Use a Kimchi API key"
export const SUBSCRIPTION_LABEL = "Use a subscription"
export const KIMCHI_DEFAULT_ENDPOINT = "https://llm.kimchi.dev"

let browserLoginLinkSeq = 0

export function getKimchiAuthPath(): string {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	return agentDir ? resolve(agentDir, "auth.json") : "auth.json"
}

export function formatKimchiLoginSuccessMessage(modelId?: string): string {
	const selectedModel = modelId ? ` Selected ${modelId}.` : ""
	return `Logged in to Kimchi.${selectedModel} Credentials saved to ${getKimchiAuthPath()}`
}

/**
 * Format the browser-login URL as a feedback message the user can act on when
 * the auto-opened browser landed in the wrong app/profile.
 *
 * The URL is wrapped as an OSC 8 terminal hyperlink so the user can right-click
 * "Copy Link" (or Cmd/Ctrl-click) and get the *complete* URL; selecting the
 * raw wrapped text injects a newline at the wrap point that corrupts the `state`
 * query param on paste.
 *
 * Two details make the wrapped link behave as a single link:
 *  - BEL terminator (`\x07`), mirroring upstream `LoginDialogComponent.showAuth`,
 *    rather than pi-tui's exported `hyperlink()` which uses the ST terminator
 *    (`\x1b\\`); pi-tui's own line-wrapper documents that ST leaves only the
 *    first wrapped physical line clickable in some terminals.
 *  - a unique `id=` param so the terminal treats the wrapped rows as ONE link
 *    and highlights the whole URL on hover (without it, each wrapped segment is a
 *    separate link and only the row under the cursor lights up). pi-tui's wrapper
 *    preserves the param when it re-opens the link on continuation rows.
 */
export function formatKimchiLoginLink(url: string): string {
	browserLoginLinkSeq += 1
	const id = `kimchi-login-${browserLoginLinkSeq}`
	return `\x1b]8;id=${id};${url}\x07${url}\x1b]8;;\x07`
}

export function formatBrowserLoginMessage(url: string): string {
	return `If the wrong browser or profile opened, right-click this link, choose "Copy Link", and open it in the correct one:\n${formatKimchiLoginLink(url)}`
}

type AuthSelectorProvider = ConstructorParameters<typeof OAuthSelectorComponent>[2][number]
interface AuthStorageLike {
	set(provider: string, credential: unknown): void
	get(provider: string): unknown
	remove?(provider: string): void
}

interface ProviderModelLike {
	id: string
	provider: string
}

interface ModelRegistryLike<TModel extends ProviderModelLike = ProviderModelLike> {
	authStorage: AuthStorageLike
	refresh(): void
	getAvailable(): TModel[]
	getProviderAuthStatus(providerId: string): AuthStatus
}

export function createLoginChoiceSelector(options: {
	onKimchiAccount: () => void
	onKimchiApiKey?: () => void
	onSubscription: () => void
	onCancel: () => void
}): ExtensionSelectorComponent {
	const labels = options.onKimchiApiKey
		? [KIMCHI_ACCOUNT_LABEL, KIMCHI_API_KEY_LABEL, SUBSCRIPTION_LABEL]
		: [KIMCHI_ACCOUNT_LABEL, SUBSCRIPTION_LABEL]
	return new ExtensionSelectorComponent(
		"Select authentication method:",
		labels,
		(option) => {
			if (option === SUBSCRIPTION_LABEL) {
				options.onSubscription()
				return
			}
			if (option === KIMCHI_API_KEY_LABEL && options.onKimchiApiKey) {
				options.onKimchiApiKey()
				return
			}
			options.onKimchiAccount()
		},
		options.onCancel,
	)
}

function upstreamModelToPiConfig(m: Model<Api>, providerId: string): PiModelConfig {
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
		compat: m.compat as PiModelConfig["compat"],
	}
}

export async function prePopulateSubscriptionModels(providerId: string): Promise<void> {
	const piModels = getModels?.(providerId as Parameters<typeof getModels>[0]) ?? []
	if (piModels.length === 0) return

	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) {
		console.warn("KIMCHI_CODING_AGENT_DIR environment variable is missing. Models cannot be cached.")
		return
	}

	const modelsJsonPath = resolve(agentDir, "models.json")
	const configs = piModels.map((m) => upstreamModelToPiConfig(m, providerId))
	const firstModel = piModels[0]
	syncProviderModels(modelsJsonPath, providerId, configs, {
		api: firstModel.api,
		baseUrl: firstModel.baseUrl,
	})
}

async function refreshKimchiModels(
	token: string,
	endpoint?: string,
	options: { allowCachedFallback?: boolean; requireActiveModels?: boolean } = {},
): Promise<void> {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	await updateModelsConfig(resolve(agentDir, "models.json"), token, { endpoint, ...options })
}

export function setKimchiAuthToken(
	modelRegistry: ModelRegistryLike,
	token: string,
	credentialType: "api_key" | "oauth" = "api_key",
): void {
	if (credentialType === "oauth") {
		modelRegistry.authStorage.set(KIMCHI_PROVIDER_ID, {
			type: "oauth",
			access: token,
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		})
		return
	}

	modelRegistry.authStorage.set(KIMCHI_PROVIDER_ID, {
		type: "api_key",
		key: token,
	})
}

export interface KimchiBrowserLoginHost {
	modelRegistry: ModelRegistryLike
	setModel?: (model: ProviderModelLike) => Promise<unknown> | unknown
	showStatus?: (message: string) => void
	showError?: (message: string) => void
	addFeedback?: (message: string) => void
	onBrowserUrl?: (url: string) => void
	/** Abort the in-flight browser login (e.g. the login dialog was cancelled). */
	signal?: AbortSignal
}

export interface KimchiBrowserLoginOptions {
	reuseExistingToken?: boolean
}

export interface KimchiApiKeyLoginOptions {
	apiKey: string
	endpoint: string
}

function restoreKimchiAuth(modelRegistry: ModelRegistryLike, previousCredential: unknown): void {
	if (previousCredential !== undefined) {
		modelRegistry.authStorage.set(KIMCHI_PROVIDER_ID, previousCredential)
		return
	}
	modelRegistry.authStorage.remove?.(KIMCHI_PROVIDER_ID)
}

function formatKimchiTokenError(error: unknown, options: { saved: boolean }): string {
	const detail = error instanceof Error ? error.message : String(error)
	const savedSuffix = options.saved
		? " Your API key was saved; wait a moment and try again."
		: " No changes were saved."
	if (isTransientModelsError(error)) {
		return `Kimchi endpoint is unreachable or temporarily unavailable (${detail}). Check the endpoint and try again.${savedSuffix}`
	}
	if (error instanceof ModelsFetchError && error.status === 401) {
		return `Invalid API key. Please check your key and try again.${savedSuffix}`
	}
	return `Kimchi model refresh failed: ${detail}.${savedSuffix}`
}

async function configureKimchiToken(
	host: KimchiBrowserLoginHost,
	token: string,
	endpoint?: string,
	options: { strictFreshDiscovery?: boolean; persistConfig?: () => void } = {},
): Promise<boolean> {
	let refreshError: unknown
	try {
		await refreshKimchiModels(token, endpoint, {
			allowCachedFallback: !options.strictFreshDiscovery,
		})
	} catch (error) {
		refreshError = error
	}

	if (refreshError && options.strictFreshDiscovery) {
		host.showError?.(formatKimchiTokenError(refreshError, { saved: false }))
		return false
	}

	const previousCredential = host.modelRegistry.authStorage.get(KIMCHI_PROVIDER_ID)
	setKimchiAuthToken(host.modelRegistry, token)
	try {
		host.modelRegistry.refresh()
	} catch (error) {
		refreshError ??= error
		if (options.strictFreshDiscovery) {
			restoreKimchiAuth(host.modelRegistry, previousCredential)
			host.showError?.(formatKimchiTokenError(error, { saved: false }))
			return false
		}
	}

	let providerModels: ProviderModelLike[] = []
	try {
		providerModels = host.modelRegistry.getAvailable().filter((m) => m.provider === KIMCHI_PROVIDER_ID)
	} catch (error) {
		refreshError ??= error
	}
	if (providerModels.length > 0) {
		options.persistConfig?.()
		const selectedModel = providerModels.find((m) => m.id === KIMCHI_DEFAULT_MODEL_ID) ?? providerModels[0]
		await host.setModel?.(selectedModel)
		host.addFeedback?.(formatKimchiLoginSuccessMessage(selectedModel.id))
		return true
	}

	if (options.strictFreshDiscovery) {
		restoreKimchiAuth(host.modelRegistry, previousCredential)
		host.showError?.("Kimchi API-key login found no available Kimchi models. No changes were saved.")
		return false
	}

	if (refreshError) {
		host.showError?.(formatKimchiTokenError(refreshError, { saved: true }))
	} else {
		host.showError?.("Kimchi login did not configure any available models. Your API key was saved; try again.")
	}
	return false
}

export async function performKimchiApiKeyLogin(
	host: KimchiBrowserLoginHost,
	options: KimchiApiKeyLoginOptions,
): Promise<boolean> {
	const token = options.apiKey.trim()
	const endpoint = options.endpoint.trim() || KIMCHI_DEFAULT_ENDPOINT
	if (!token) {
		host.showError?.("Kimchi API key is required.")
		return false
	}

	try {
		host.showStatus?.(`Refreshing Kimchi models from ${endpoint}...`)
		return await configureKimchiToken(host, token, endpoint, {
			strictFreshDiscovery: true,
			persistConfig: () => writeApiKey(token, undefined, { llmEndpoint: endpoint }),
		})
	} catch (error) {
		host.showError?.(`Kimchi API-key login failed: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
}

export async function performKimchiBrowserLogin(
	host: KimchiBrowserLoginHost,
	options: KimchiBrowserLoginOptions = {},
): Promise<boolean> {
	const existingToken = options.reuseExistingToken ? loadConfig().apiKey : ""
	if (existingToken) {
		host.showStatus?.("Refreshing Kimchi models with existing login...")
		return configureKimchiToken(host, existingToken)
	}

	let browserUrl: string | undefined
	try {
		host.showStatus?.("Opening browser for Kimchi login...")

		const { token } = await authenticateViaBrowser({
			onBrowserUrl: (url) => {
				browserUrl = url
				host.onBrowserUrl?.(url)
			},
			signal: host.signal,
		})

		writeApiKey(token)
		return configureKimchiToken(host, token)
	} catch (error) {
		// User cancelled (Esc in the login dialog aborts host.signal); that's not a
		// failure, so stay silent instead of flashing an error toast and a misleading
		// "Couldn't open browser" hint. Mirrors the subscription path, which ignores
		// the "Login cancelled" error from authStorage.login.
		if (host.signal?.aborted) return false
		if (browserUrl) {
			host.addFeedback?.(`Couldn't open browser automatically. Visit: ${browserUrl}`)
		}
		host.showError?.(`Kimchi login failed: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
}

export type KimchiBrowserLoginDialogResult = "success" | "failed" | "cancelled"

/**
 * Run the Kimchi browser login inside pi's `LoginDialogComponent`, mirroring how
 * subscription login is presented (`showOAuthLoginDialogWithExtensionUI`). We reuse
 * the dialog for its chrome and lifecycle: bordered "Log in to Kimchi" box, focus,
 * and Esc-to-cancel (wired to abort the callback server). We feed it our own
 * `formatKimchiLoginLink` via `showInfo` rather than the dialog's `showAuth`, which
 * renders the URL without the `id=` grouping that keeps the wrapped link clickable
 * and fully highlighted.
 */
export async function performKimchiBrowserLoginWithDialog(
	ctx: ExtensionContext,
	setModel?: (model: ProviderModelLike) => Promise<unknown> | unknown,
): Promise<KimchiBrowserLoginDialogResult> {
	return ctx.ui.custom<KimchiBrowserLoginDialogResult>((tui, _theme, _keybindings, done) => {
		let finished = false
		let cancelled = false
		const finish = (result: KimchiBrowserLoginDialogResult) => {
			if (finished) return
			finished = true
			done(result)
		}

		const dialog = new LoginDialogComponent(
			tui,
			KIMCHI_PROVIDER_ID,
			// Fires when the dialog is cancelled (Esc). The abort below tears down the
			// callback server; closing the dialog here resolves the surrounding custom.
			(success) => {
				if (!success) {
					cancelled = true
					finish("cancelled")
				}
			},
			"Kimchi",
			"Log in to Kimchi",
		)

		void (async () => {
			const ok = await performKimchiBrowserLogin(
				{
					modelRegistry: ctx.modelRegistry,
					setModel,
					showStatus: (message) => dialog.showProgress(message),
					showError: (message) => ctx.ui.notify(message, "error"),
					addFeedback: (message) => dialog.showProgress(message),
					onBrowserUrl: (url) =>
						dialog.showInfo([
							'If the wrong browser or profile opened, right-click this link, choose "Copy Link", and open it in the correct one:',
							"",
							formatKimchiLoginLink(url),
						]),
					signal: dialog.signal,
				},
				{ reuseExistingToken: true },
			)
			if (cancelled || dialog.signal.aborted) finish("cancelled")
			else finish(ok ? "success" : "failed")
		})()

		return dialog
	})
}

export async function performKimchiApiKeyLoginViaExtensionUI(
	ctx: ExtensionContext,
	setModel?: (model: ProviderModelLike) => Promise<unknown> | unknown,
): Promise<"success" | "failed" | "cancelled"> {
	const apiKey = await ctx.ui.input("Kimchi API Key:")
	if (!apiKey?.trim()) return "cancelled"
	const endpoint = await ctx.ui.input(`Kimchi endpoint (press Enter to use ${KIMCHI_DEFAULT_ENDPOINT}):`)
	const trimmedEndpoint = endpoint?.trim() || KIMCHI_DEFAULT_ENDPOINT
	const ok = await performKimchiApiKeyLogin(
		{
			modelRegistry: ctx.modelRegistry,
			setModel,
			showStatus: (message) => ctx.ui.notify(message, "info"),
			showError: (message) => ctx.ui.notify(message, "error"),
			addFeedback: (message) => ctx.ui.notify(message, "info"),
		},
		{ apiKey: apiKey.trim(), endpoint: trimmedEndpoint },
	)
	return ok ? "success" : "failed"
}

export function getSubscriptionProviderOptions(
	modelRegistry: ExtensionContext["modelRegistry"],
): AuthSelectorProvider[] {
	const providers = modelRegistry.authStorage.getOAuthProviders()
	return providers
		.filter((provider) => provider.id !== KIMCHI_PROVIDER_ID)
		.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth" as const,
		}))
		.sort((a, b) => a.name.localeCompare(b.name))
}

class SwappableAuthComponent extends Container {
	private current: unknown
	private _focused = false

	constructor(private readonly tui: TUI) {
		super()
	}

	get focused(): boolean {
		return this._focused
	}

	set focused(value: boolean) {
		this._focused = value
		this.setChildFocused(value)
	}

	set(component: unknown): void {
		this.current = component
		this.clear()
		this.addChild(component as Component)
		this.setChildFocused(this._focused)
		this.tui.requestRender()
	}

	handleInput(data: string): void {
		const inputHandler = (this.current as { handleInput?: (data: string) => void } | undefined)?.handleInput
		inputHandler?.(data)
	}

	private setChildFocused(focused: boolean): void {
		const maybeFocusable = this.current as { focused?: boolean } | undefined
		if (maybeFocusable && "focused" in maybeFocusable) {
			maybeFocusable.focused = focused
		}
	}
}

function showOAuthLoginSelectInHost(
	host: SwappableAuthComponent,
	dialog: LoginDialogComponent,
	prompt: Parameters<
		NonNullable<Parameters<ExtensionContext["modelRegistry"]["authStorage"]["login"]>[1]["onSelect"]>
	>[0],
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const labels = prompt.options.map((option) => option.label)
		const selector = new ExtensionSelectorComponent(
			prompt.message,
			labels,
			(optionLabel) => {
				host.set(dialog)
				resolve(prompt.options.find((option) => option.label === optionLabel)?.id)
			},
			() => {
				host.set(dialog)
				resolve(undefined)
			},
		)
		host.set(selector)
	})
}

async function showOAuthLoginDialogWithExtensionUI(
	ctx: ExtensionContext,
	providerId: string,
	providerName: string,
): Promise<boolean> {
	const providerInfo = ctx.modelRegistry.authStorage.getOAuthProviders().find((provider) => provider.id === providerId)
	const usesCallbackServer = providerInfo?.usesCallbackServer ?? false

	return ctx.ui.custom<boolean>((tui, _theme, _keybindings, done) => {
		const host = new SwappableAuthComponent(tui)
		let finished = false
		const finish = (result: boolean) => {
			if (finished) return
			finished = true
			done(result)
		}
		const dialog = new LoginDialogComponent(
			tui,
			providerId,
			(success) => {
				if (!success) finish(false)
			},
			providerName,
		)
		host.set(dialog)

		void (async () => {
			let manualCodeResolve: ((value: string) => void) | undefined
			let manualCodeReject: ((error: Error) => void) | undefined
			const manualCodePromise = new Promise<string>((resolve, reject) => {
				manualCodeResolve = resolve
				manualCodeReject = reject
			})

			try {
				await ctx.modelRegistry.authStorage.login(providerId, {
					onAuth: (info) => {
						dialog.showAuth(info.url, info.instructions)
						if (usesCallbackServer) {
							dialog
								.showManualInput("Paste redirect URL below, or complete login in browser:")
								.then((value) => {
									if (value && manualCodeResolve) {
										manualCodeResolve(value)
										manualCodeResolve = undefined
									}
								})
								.catch(() => {
									if (manualCodeReject) {
										manualCodeReject(new Error("Login cancelled"))
										manualCodeReject = undefined
									}
								})
						} else if (providerId === "github-copilot") {
							dialog.showWaiting("Waiting for browser authentication...")
						}
					},
					onDeviceCode: (info) => {
						dialog.showDeviceCode(info)
						dialog.showWaiting("Waiting for authentication...")
					},
					onPrompt: async (prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
					onProgress: (message) => {
						dialog.showProgress(message)
					},
					onSelect: (prompt) => showOAuthLoginSelectInHost(host, dialog, prompt),
					onManualCodeInput: () => manualCodePromise,
					signal: dialog.signal,
				})
				finish(true)
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				if (errorMsg !== "Login cancelled") {
					ctx.ui.notify(`Failed to login to ${providerName}: ${errorMsg}`, "error")
				}
				finish(false)
			}
		})()

		return host
	})
}

export async function showSubscriptionLoginWithExtensionUI(
	ctx: ExtensionContext,
	setModel?: (model: Model<Api>) => Promise<unknown> | unknown,
): Promise<boolean> {
	const providerOptions = getSubscriptionProviderOptions(ctx.modelRegistry)
	if (providerOptions.length === 0) {
		ctx.ui.notify("No subscription providers available.", "warning")
		return false
	}

	const providerId = await ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
		const selector = new OAuthSelectorComponent(
			"login",
			ctx.modelRegistry.authStorage,
			providerOptions,
			(selectedProviderId) => done(selectedProviderId),
			() => done(undefined),
			(id) => ctx.modelRegistry.getProviderAuthStatus(id),
		)
		return selector
	})
	if (!providerId) return false

	const providerOption = providerOptions.find((provider) => provider.id === providerId)
	if (!providerOption) return false

	try {
		await prePopulateSubscriptionModels(providerOption.id)
		const success = await showOAuthLoginDialogWithExtensionUI(ctx, providerOption.id, providerOption.name)
		if (!success) return false

		ctx.modelRegistry.refresh()
		const providerModels = ctx.modelRegistry.getAvailable().filter((model) => model.provider === providerOption.id)
		const selectedModel = providerModels[0]
		if (selectedModel) {
			await setModel?.(selectedModel)
			ctx.ui.notify(`Logged in to ${providerOption.name}. Model: ${selectedModel.id}`, "info")
		} else {
			ctx.ui.notify(`Logged in to ${providerOption.name}. Use /model to select a model.`, "info")
		}
		return true
	} catch (error) {
		ctx.ui.notify(`Subscription login failed: ${error instanceof Error ? error.message : String(error)}`, "error")
		return false
	}
}
