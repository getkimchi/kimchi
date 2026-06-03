import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import {
	KIMCHI_PROVIDER_ID,
	createLoginChoiceSelector,
	performKimchiApiKeyLoginViaExtensionUI,
	performKimchiBrowserLoginWithDialog,
	setKimchiAuthToken,
	showSubscriptionLoginWithExtensionUI,
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

export function seedKimchiAuthFromConfig(ctx: ExtensionContext): void {
	seedKimchiAuthFromConfigAndReturnKey(ctx)
}

function seedKimchiAuthFromConfigAndReturnKey(ctx: ExtensionContext): string {
	const configKey = loadConfig().apiKey
	if (configKey) {
		setKimchiAuthToken(ctx.modelRegistry, configKey, "oauth")
	}
	return configKey
}

export function hasUsableAuth(ctx: ExtensionContext): boolean {
	const configKey = seedKimchiAuthFromConfigAndReturnKey(ctx)
	try {
		ctx.modelRegistry.refresh()
	} catch {
		// Broken models.json is reported by upstream startup warnings. Treat it
		// as unauthenticated here so the user gets a login path instead of Ferment.
	}
	try {
		const availableModels = ctx.modelRegistry.getAvailable()
		if (availableModels.length === 0) return false
		if (availableModels.some((model) => model.provider !== KIMCHI_PROVIDER_ID)) return true
		return configKey.length > 0
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

async function promptAuthChoice(ctx: ExtensionContext): Promise<"kimchi" | "api-key" | "subscription" | undefined> {
	await waitForOverlayClear(ctx)
	return ctx.ui.custom<"kimchi" | "api-key" | "subscription" | undefined>((_tui, _theme, _keybindings, done) => {
		const selector = createLoginChoiceSelector({
			onKimchiAccount: () => done("kimchi"),
			onKimchiApiKey: () => done("api-key"),
			onSubscription: () => done("subscription"),
			onCancel: () => done(undefined),
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

		const result =
			choice === "kimchi"
				? await performKimchiBrowserLoginWithDialog(ctx, (model) =>
						pi.setModel(model as Parameters<typeof pi.setModel>[0]),
					)
				: choice === "api-key"
					? await performKimchiApiKeyLoginViaExtensionUI(ctx, (model) =>
							pi.setModel(model as Parameters<typeof pi.setModel>[0]),
						)
					: (await showSubscriptionLoginWithExtensionUI(ctx, (model) => pi.setModel(model)))
						? "success"
						: "failed"

		if (result === "cancelled") continue

		if (result === "success" && hasUsableAuth(ctx)) {
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
			if (
				!shouldShowStartupAuthGate({
					hasUI: ctx.hasUI,
					stdinIsTTY: options.stdinIsTTY,
					stdoutIsTTY: options.stdoutIsTTY,
					nonInteractiveMode: options.nonInteractiveMode,
					sessionStartReason: event.reason,
					hasUsableAuth: hasUsableAuth(ctx),
				})
			) {
				return
			}

			await runStartupAuthGate(pi, ctx, state, options)
		})
	}
}
