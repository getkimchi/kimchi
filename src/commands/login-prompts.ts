/**
 * CLI prompt adapters for `kimchi login` — clack surfaces over the same
 * choices the TUI `/login` selector presents (src/extensions/login/flow.ts
 * single-sources the labels and ordering). Esc at any step backs out
 * (`back`, mirroring /login's navigation to the previous selector); Ctrl-C
 * aborts (`cancel`). The Outcome semantics come from the shared wizard
 * prompt wrappers in src/setup-wizard/prompt.ts.
 */

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth"
import open from "open"
import { readE2eSeam } from "../extensions/e2e-seam.js"
import {
	LOGIN_METHOD_SELECTOR_TITLE,
	type LoginMethodId,
	loginMethodChoices,
	promptSelfHostedEndpoints,
	REGION_SELECTOR_TITLE,
} from "../extensions/login/flow.js"
import type { KimchiRegion, RegionId, SelfHostedEndpoints } from "../regions.js"
import type { fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"
import { type Outcome, password, select, text } from "../setup-wizard/prompt.js"

/**
 * The auth-method menu: CAST AI SSO first (the recommended login) when the
 * region has an OAuth tenant, then Kimchi account and API key. Subscription
 * login stays TUI-only — it needs the live-session OAuth dialogs of `/login`.
 */
export function promptLoginMethod(ssoAvailable: boolean): Promise<Outcome<LoginMethodId>> {
	const choices = loginMethodChoices({ ssoAvailable, includeApiKey: true, includeSubscription: false })
	return select({
		message: LOGIN_METHOD_SELECTOR_TITLE,
		options: choices.map((choice) => ({ value: choice.id, label: choice.label })),
		backable: true,
	})
}

/**
 * The region menu. `regions` must already be in current-first order (see
 * orderedLoginRegions in flow.ts); the current region carries the same
 * " — current" suffix as the TUI selector.
 */
export function promptLoginRegion(regions: KimchiRegion[], currentRegion: RegionId): Promise<Outcome<RegionId>> {
	return select({
		message: REGION_SELECTOR_TITLE,
		options: regions.map((region) => ({
			value: region.id,
			label: region.id === currentRegion ? `${region.label} — current` : region.label,
		})),
		initialValue: currentRegion,
		backable: true,
	})
}

/**
 * Thrown through promptSelfHostedEndpoints when the clack text input is
 * Ctrl-C'd: the shared function's `undefined` contract means "back", so a
 * hard abort must travel as an exception instead of a flag.
 */
class SelfHostedPromptCancelled extends Error {}

/**
 * Self-hosted console-URL prompt reusing the surface-agnostic
 * promptSelfHostedEndpoints (discovery validation, re-prompting, stored-URL
 * default) with clack text input. Esc backs out; Ctrl-C aborts.
 */
export async function promptSelfHostedConsoleEndpoints(
	storedUrl?: string,
	deps: { discoverEndpoints?: typeof fetchSelfHostedEndpoints } = {},
): Promise<Outcome<SelfHostedEndpoints>> {
	try {
		const endpoints = await promptSelfHostedEndpoints({
			prompt: async (title, placeholder) => {
				const outcome = await text({ message: title, placeholder, backable: true })
				if (outcome.kind === "cancel") throw new SelfHostedPromptCancelled()
				return outcome.kind === "back" ? undefined : outcome.value
			},
			notifyError: (message) => console.error(message),
			notifyStatus: (message) => console.log(message),
			storedUrl,
			discoverEndpoints: deps.discoverEndpoints,
		})
		return endpoints ? { kind: "next", value: endpoints } : { kind: "back" }
	} catch (error) {
		if (error instanceof SelfHostedPromptCancelled) return { kind: "cancel" }
		throw error
	}
}

/** API-key prompt — the key is secret, so a password (masked) input. */
export function promptKimchiApiKey(): Promise<Outcome<string>> {
	return password({
		message: "Kimchi API Key:",
		validate: (value) => (value?.trim() ? undefined : "Kimchi API key is required."),
		backable: true,
	})
}

/** Endpoint prompt for cloud regions: Enter keeps the region default. */
export async function promptKimchiEndpoint(defaultEndpoint: string): Promise<Outcome<string>> {
	const outcome = await text({
		message: `Kimchi endpoint (press Enter to use ${defaultEndpoint}):`,
		backable: true,
	})
	if (outcome.kind !== "next") return outcome
	return { kind: "next", value: outcome.value.trim() || defaultEndpoint }
}

/**
 * OAuth callbacks driving loginWithCastAiOauth (CAST AI SSO) in a terminal:
 * prints and opens the authorize URL, prompts for the manual redirect
 * paste-back, and renders organization selection as a clack select.
 *
 * All prompts share the caller's AbortController. The flow races the
 * callback-server wait against the manual-code prompt and swallows the
 * losing branch's rejection: when the server wins, the owner aborts this
 * controller (which settles the outstanding prompt below); when the user
 * cancels a prompt, the callback itself aborts so the wait actually ends
 * (the caller races on the signal).
 */
export function createCliSsoCallbacks(controller: AbortController): OAuthLoginCallbacks {
	return {
		signal: controller.signal,
		onAuth: (info) => {
			if (info.instructions) console.log(info.instructions)
			console.log(`\n${info.url}\n`)
			// Mirror cli-auth/index.ts: the e2e rigs must not pop a real browser.
			if (readE2eSeam("KIMCHI_E2E_FAKE_BROWSER_OPEN") === "1") {
				console.log("If the browser did not open automatically, visit the URL above.")
				return
			}
			open(info.url).catch(() => {
				console.log("Couldn't open your browser automatically. Please visit the URL above manually.")
			})
		},
		onProgress: (message) => console.log(message),
		onPrompt: (prompt) => ssoTextPrompt(controller, prompt.message, prompt.placeholder),
		onManualCodeInput: () => ssoTextPrompt(controller, "Paste the final redirect URL:"),
		onSelect: async (prompt) => {
			const outcome = await ssoPrompt(controller, () =>
				select({
					message: prompt.message,
					options: prompt.options.map((option) => ({ value: option.id, label: option.label })),
					backable: true,
				}),
			)
			// Undefined abandons the selection; selectOrganization (cli-auth/oauth)
			// maps it to "Login cancelled" on the main flow path.
			return outcome.kind === "next" ? outcome.value : undefined
		},
		onDeviceCode: () => {},
	}
}

/**
 * Race a clack prompt against the shared signal so an abort settles the
 * promise even though clack itself ignores external signals (its rendered
 * line is torn down at process exit, which node restores termios for).
 */
function ssoPrompt<T>(controller: AbortController, run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	if (controller.signal.aborted) return Promise.resolve({ kind: "cancel" })
	return new Promise((resolve) => {
		const onAbort = () => resolve({ kind: "cancel" })
		controller.signal.addEventListener("abort", onAbort, { once: true })
		run()
			.finally(() => controller.signal.removeEventListener("abort", onAbort))
			.then(resolve)
	})
}

async function ssoTextPrompt(controller: AbortController, message: string, placeholder?: string): Promise<string> {
	const outcome = await ssoPrompt(controller, () => text({ message, placeholder, backable: true }))
	if (outcome.kind !== "next") {
		controller.abort()
		throw new Error("Login cancelled")
	}
	return outcome.value
}
