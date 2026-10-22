import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { getApiKeySource, loadConfig } from "../../config.js"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "../../kimchi-provider.js"
import { ssoAvailableRegions } from "../../oauth-config.js"
import type { RegionId } from "../../regions.js"
import {
	createLoginChoiceSelector,
	createRegionSelector,
	performKimchiApiKeyLoginViaExtensionUI,
	performKimchiBrowserLoginWithDialog,
	performKimchiSsoLoginWithExtensionUI,
	regionChoiceRequired,
	showSubscriptionLoginWithExtensionUI,
	syncKimchiAuth,
} from "./flow.js"

const STARTUP_AUTH_OVERLAY_WAIT_KEY = "kimchi-startup-auth-overlay-wait"
const OVERLAY_WAIT_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const SHIM_COMPONENT = { render: () => [], invalidate: () => {} } as const

export interface StartupAuthGateState {
	attempted: boolean
	authenticated: boolean
	cancelled: boolean
}

export interface StartupAuthGateOptions {
	nonInteractiveMode: boolean
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
	state?: StartupAuthGateState
	onCancel?: (ctx: ExtensionContext) => void | Promise<void>
}

export function createStartupAuthGateState(): StartupAuthGateState {
	return { attempted: false, authenticated: false, cancelled: false }
}

export function shouldShowStartupAuthGate(input: {
	hasUI: boolean
	stdinIsTTY: boolean
	stdoutIsTTY: boolean
	nonInteractiveMode: boolean
	sessionStartReason?: SessionStartEvent["reason"]
	hasUsableAuth: boolean
}): boolean {
	if (input.sessionStartReason !== undefined && input.sessionStartReason !== "startup") {
		return false
	}
	if (!input.hasUI || !input.stdinIsTTY || !input.stdoutIsTTY) {
		return false
	}
	if (input.nonInteractiveMode) return false
	if (input.hasUsableAuth) return false
	return true
}

export async function hasUsableAuth(ctx: ExtensionContext): Promise<boolean> {
	const configKey = loadConfig().apiKey
	let kimchiAuthSynchronized = configKey.length === 0
	// SSO credentials live in auth.json (type: "oauth") with no config apiKey —
	// a configured OAuth credential counts toward usable auth like a key does.
	let oauthConfigured = false
	try {
		if (configKey) {
			if (getApiKeySource() === "environment") {
				await ctx.modelRegistry.refresh()
			} else {
				await syncKimchiAuth(ctx.modelRegistry, configKey)
			}
			kimchiAuthSynchronized = true
		} else {
			await ctx.modelRegistry.refresh()
			oauthConfigured = ctx.modelRegistry.getProviderAuthStatus(KIMCHI_PROVIDER_ID)?.configured === true
		}
	} catch {
		// Broken models.json is reported by upstream startup warnings. Treat it
		// as unauthenticated here so the user gets a login path instead of Ferment.
	}
	try {
		const availableModels = ctx.modelRegistry.getAvailable()
		if (availableModels.length === 0) return false
		if (availableModels.some((model) => !isKimchiProvider(model.provider))) return true
		return (configKey.length > 0 || oauthConfigured) && kimchiAuthSynchronized
	} catch {
		return false
	}
}

async function waitForOverlayClear(ctx: ExtensionContext): Promise<void> {
	let tuiRef: { hasOverlay?: () => boolean } | undefined
	let unsubscribeInput: (() => void) | undefined

	return new Promise((resolve) => {
		let done = false
		const cleanup = () => {
			ctx.ui.setWidget(STARTUP_AUTH_OVERLAY_WAIT_KEY, undefined, OVERLAY_WAIT_WIDGET_OPTIONS)
			unsubscribeInput?.()
			unsubscribeInput = undefined
		}
		const tryResolve = () => {
			if (done || !tuiRef) return
			if (typeof tuiRef.hasOverlay === "function" && tuiRef.hasOverlay()) return
			done = true
			cleanup()
			resolve()
		}

		ctx.ui.setWidget(
			STARTUP_AUTH_OVERLAY_WAIT_KEY,
			(tui) => {
				tuiRef = tui as unknown as { hasOverlay?: () => boolean }
				queueMicrotask(tryResolve)
				return SHIM_COMPONENT
			},
			OVERLAY_WAIT_WIDGET_OPTIONS,
		)
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			setTimeout(tryResolve, 0)
			return undefined
		})
	})
}

async function promptAuthChoice(
	ctx: ExtensionContext,
): Promise<"sso" | "kimchi" | "api-key" | "subscription" | undefined> {
	await waitForOverlayClear(ctx)
	return ctx.ui.custom<"sso" | "kimchi" | "api-key" | "subscription" | undefined>(
		(_tui, _theme, _keybindings, done) => {
			const selector = createLoginChoiceSelector({
				onKimchiSso: () => done("sso"),
				onKimchiAccount: () => done("kimchi"),
				onKimchiApiKey: () => done("api-key"),
				onSubscription: () => done("subscription"),
				onCancel: () => done(undefined),
			})
			return selector
		},
	)
}

/**
 * Region pick preceding Kimchi account/API-key login in the startup gate.
 * Back (Esc) returns `undefined` so the gate loops back to the auth-method
 * selector — the selector owns gate cancellation.
 */
async function promptRegionChoice(ctx: ExtensionContext): Promise<RegionId | undefined> {
	const currentRegion = loadConfig().region
	// Skip the picker when experimental gating leaves no choice.
	if (!regionChoiceRequired(currentRegion)) return currentRegion
	return ctx.ui.custom<RegionId | undefined>((_tui, _theme, _keybindings, done) => {
		const selector = createRegionSelector({
			currentRegion,
			onSelect: (region) => done(region),
			onBack: () => done(undefined),
		})
		return selector
	})
}

/**
 * Region pick preceding a CAST AI SSO login in the startup gate: SSO tenants
 * exist per region (US and EU), so unlike the key-login region prompt this
 * lists the SSO-capable regions. Back (Esc) returns `undefined` so the gate
 * loops back to the auth-method selector.
 */
async function promptSsoRegionChoice(ctx: ExtensionContext): Promise<RegionId | undefined> {
	const currentRegion = loadConfig().region
	const ssoRegions = ssoAvailableRegions()
	if (ssoRegions.length <= 1) return currentRegion
	return ctx.ui.custom<RegionId | undefined>((_tui, _theme, _keybindings, done) => {
		const selector = createRegionSelector({
			currentRegion,
			regions: ssoRegions,
			onSelect: (region) => done(region),
			onBack: () => done(undefined),
		})
		return selector
	})
}

function defaultCancel(ctx: ExtensionContext): Promise<never> {
	ctx.ui.notify("Login cancelled. Run `kimchi login` or `kimchi setup` to authenticate.", "warning")
	ctx.shutdown()
	// Keep session_start from falling through to the unauthenticated editor while
	// interactive shutdown drains input, stops the TUI, and exits the process.
	return new Promise<never>(() => {})
}

async function runStartupAuthGate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: StartupAuthGateState,
	options: StartupAuthGateOptions,
): Promise<void> {
	state.attempted = true

	for (;;) {
		const choice = await promptAuthChoice(ctx)
		if (!choice) {
			state.cancelled = true
			await (options.onCancel ?? defaultCancel)(ctx)
			return
		}

		let result: "success" | "failed" | "cancelled"
		if (choice === "subscription") {
			result = (await showSubscriptionLoginWithExtensionUI(ctx, (model) => pi.setModel(model, { persist: true })))
				? "success"
				: "failed"
		} else if (choice === "sso") {
			// The recommended login: browser OAuth with a refreshable,
			// organization-scoped credential.
			const region = await promptSsoRegionChoice(ctx)
			if (region === undefined) continue
			result = await performKimchiSsoLoginWithExtensionUI(
				ctx,
				(model) => pi.setModel(model as Parameters<typeof pi.setModel>[0], { persist: true }),
				{ region },
			)
		} else {
			// Both Kimchi-led paths start with a region pick; it drives the web-app
			// URL (browser) or the endpoint default (API key) and is persisted with
			// the token. Back returns to the auth-method selector.
			const region = await promptRegionChoice(ctx)
			if (region === undefined) continue
			result =
				choice === "kimchi"
					? await performKimchiBrowserLoginWithDialog(
							ctx,
							(model) => pi.setModel(model as Parameters<typeof pi.setModel>[0], { persist: true }),
							{ region },
						)
					: await performKimchiApiKeyLoginViaExtensionUI(
							ctx,
							(model) => pi.setModel(model as Parameters<typeof pi.setModel>[0], { persist: true }),
							{ region },
						)
		}

		if (result === "cancelled") continue

		if (result === "success" && (await hasUsableAuth(ctx))) {
			state.authenticated = true
			return
		}

		ctx.ui.notify("Login did not configure an available model. Try again or cancel.", "warning")
	}
}

export function createStartupAuthGate(options: StartupAuthGateOptions): ExtensionFactory {
	const state = options.state ?? createStartupAuthGateState()

	return (pi: ExtensionAPI) => {
		pi.on("session_start", async (event, ctx) => {
			const usableAuth = await hasUsableAuth(ctx)
			if (
				!shouldShowStartupAuthGate({
					hasUI: ctx.hasUI,
					stdinIsTTY: options.stdinIsTTY,
					stdoutIsTTY: options.stdoutIsTTY,
					nonInteractiveMode: options.nonInteractiveMode,
					sessionStartReason: event.reason,
					hasUsableAuth: usableAuth,
				})
			) {
				return
			}

			await runStartupAuthGate(pi, ctx, state, options)
		})
	}
}
