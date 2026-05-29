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
import { type PiModelConfig, syncProviderModels, updateModelsConfig } from "../../models.js"

export const KIMCHI_PROVIDER_ID = "kimchi-dev"
export const KIMCHI_DEFAULT_MODEL_ID = "kimi-k2.6"
export const KIMCHI_ACCOUNT_LABEL = "Use a Kimchi account"
export const SUBSCRIPTION_LABEL = "Use a subscription"

type AuthSelectorProvider = ConstructorParameters<typeof OAuthSelectorComponent>[2][number]
interface AuthStorageLike {
	set(provider: string, credential: unknown): void
	get(provider: string): unknown
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
	onSubscription: () => void
	onCancel: () => void
}): ExtensionSelectorComponent {
	return new ExtensionSelectorComponent(
		"Select authentication method:",
		[KIMCHI_ACCOUNT_LABEL, SUBSCRIPTION_LABEL],
		(option) => {
			if (option === SUBSCRIPTION_LABEL) {
				options.onSubscription()
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

async function refreshKimchiModels(token: string): Promise<void> {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	await updateModelsConfig(resolve(agentDir, "models.json"), token)
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
}

async function configureKimchiToken(host: KimchiBrowserLoginHost, token: string): Promise<boolean> {
	let refreshError: unknown
	try {
		await refreshKimchiModels(token)
	} catch (error) {
		refreshError = error
	}

	setKimchiAuthToken(host.modelRegistry, token)
	try {
		host.modelRegistry.refresh()
	} catch (error) {
		refreshError ??= error
	}

	let providerModels: ProviderModelLike[] = []
	try {
		providerModels = host.modelRegistry.getAvailable().filter((m) => m.provider === KIMCHI_PROVIDER_ID)
	} catch (error) {
		refreshError ??= error
	}
	if (providerModels.length > 0) {
		const selectedModel = providerModels.find((m) => m.id === KIMCHI_DEFAULT_MODEL_ID) ?? providerModels[0]
		await host.setModel?.(selectedModel)
		host.addFeedback?.(`✓ Logged in. Model: ${selectedModel.id}`)
		return true
	}

	if (refreshError) {
		host.showError?.(
			`Kimchi model refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
		)
	} else {
		host.showError?.("Kimchi login did not configure any available models. Your API key was saved; try again.")
	}
	return false
}

export async function performKimchiBrowserLogin(host: KimchiBrowserLoginHost): Promise<boolean> {
	const existingToken = loadConfig().apiKey
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
		})

		writeApiKey(token)
		return configureKimchiToken(host, token)
	} catch (error) {
		if (browserUrl) {
			host.addFeedback?.(`Couldn't open browser automatically. Visit: ${browserUrl}`)
		}
		host.showError?.(`Kimchi login failed: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
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
