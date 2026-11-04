/**
 * `kimchi login` — the CLI mirror of the interactive `/login` command
 * (src/login-command-patch.ts + src/extensions/login/flow.ts).
 *
 * Interactive terminal: the same three-step chain — auth method (CAST AI SSO /
 * Kimchi account / Kimchi API key, ordered by loginMethodChoices), region
 * (current first, self-hosted via console-URL + discovery), then the
 * method-specific prompts or browser wait — and the same post-login
 * finalization the TUI performs: models.json refresh, auth.json sync, org
 * header, default-model persistence (via pi's SettingsManager), billing
 * refresh, and the key-mismatch warning.
 *
 * Non-interactive stdin (scripts, CI, ACP terminal auth): the legacy direct
 * browser login against the configured region — no prompts — kept byte-
 * identical for compatibility.
 *
 * `kimchi login <console-url>`: the self-hosted shortcut — endpoints come
 * from the URL argument, everything else (discovery + full finalization) is
 * the interactive account flow without prompts.
 */

import { join } from "node:path"
import { emitKeypressEvents } from "node:readline"
import { spinner } from "@clack/prompts"
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { authenticateViaBrowser } from "../cli-auth/index.js"
import { LOGIN_CANCELLED_MESSAGE, loginWithCastAiOauth } from "../cli-auth/oauth.js"
import { endpointsForRegion, getApiKeyMismatchWarning, loadConfig, writeApiKey } from "../config.js"
import {
	completeKimchiSsoLogin,
	formatBrowserLoginMessage,
	installKimchiOAuth,
	type KimchiBrowserLoginHost,
	orderedLoginRegions,
	performKimchiApiKeyLogin,
	performKimchiBrowserLogin,
	regionChoiceRequired,
} from "../extensions/login/flow.js"
import { resolveOAuthLoginConfig, setPendingOAuthRegion, ssoAvailableRegions } from "../oauth-config.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import { normalizeSelfHostedBaseUrl, type RegionId, type SelfHostedEndpoints } from "../regions.js"
import { discoveryFailureMessage, fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"
import type { Outcome } from "../setup-wizard/prompt.js"
import {
	createCliSsoCallbacks,
	promptKimchiApiKey,
	promptKimchiEndpoint,
	promptLoginMethod,
	promptLoginRegion,
	promptSelfHostedConsoleEndpoints,
} from "./login-prompts.js"

export interface LoginDeps {
	/** Interactive selectors require a real TTY; default: stdin. */
	isInteractive?: () => boolean
}

export async function runLogin(args: string[], deps: LoginDeps = {}): Promise<number> {
	if (args.length > 1) {
		console.error("Usage: kimchi login [console-url] — pass at most one URL.")
		return 1
	}
	// `kimchi login <console-url>` runs the self-hosted flow; no argument keeps
	// the interactive default (the configured region's web app).
	if (args[0]) return runSelfHostedLogin(args[0])
	const interactive = deps.isInteractive?.() ?? process.stdin.isTTY === true
	if (interactive) return runInteractiveLogin()
	return runCloudLogin()
}

// ---------------------------------------------------------------------------
// Interactive flow (`/login` parity)
// ---------------------------------------------------------------------------

/** Prompt results beyond "back to the method selector" map to an exit code. */
type MethodResult = number | "back"

async function runInteractiveLogin(): Promise<number> {
	const ssoAvailable = ssoAvailableRegions().length > 0
	for (;;) {
		const method = await promptLoginMethod(ssoAvailable)
		if (method.kind === "back") {
			console.log("Login cancelled.")
			return 0
		}
		if (method.kind === "cancel") {
			console.log("Login cancelled.")
			return 130
		}
		const result =
			method.value === "sso"
				? await runSsoMethod()
				: method.value === "api-key"
					? await runApiKeyMethod()
					: await runAccountMethod()
		if (result !== "back") return result
	}
}

/** Pick a region like the TUI selector: current first, skipped without a choice. */
async function pickRegion(regions?: Parameters<typeof orderedLoginRegions>[1]): Promise<Outcome<RegionId>> {
	const currentRegion = loadConfig().region
	if (regions === undefined && !regionChoiceRequired(currentRegion)) {
		return { kind: "next", value: currentRegion }
	}
	return promptLoginRegion(orderedLoginRegions(currentRegion, regions), currentRegion)
}

/** Map a mid-flow prompt's back/cancel to the runner's result vocabulary. */
function midFlowExit<T>(outcome: Outcome<T>): { exit: MethodResult } | { value: T } {
	if (outcome.kind === "back") return { exit: "back" }
	if (outcome.kind === "cancel") {
		console.log("Login cancelled.")
		return { exit: 130 }
	}
	return { value: outcome.value }
}

async function runAccountMethod(): Promise<MethodResult> {
	const region = midFlowExit(await pickRegion())
	if ("exit" in region) return region.exit

	let selfHostedEndpoints: SelfHostedEndpoints | undefined
	if (region.value === "self-hosted") {
		const endpoints = midFlowExit(await promptSelfHostedConsoleEndpoints(loadConfig().selfHostedEndpoints?.console))
		if ("exit" in endpoints) return endpoints.exit
		selfHostedEndpoints = endpoints.value
	}
	return runAccountLogin(region.value, selfHostedEndpoints)
}

/**
 * The browser account login + full finalization, shared by the interactive
 * method and the self-hosted shortcut (which skips the prompts by passing
 * region/endpoints in directly). For region "self-hosted" the discovered
 * endpoints are required.
 */
async function runAccountLogin(region: RegionId, selfHostedEndpoints?: SelfHostedEndpoints): Promise<number> {
	return withInFlightCancel(async ({ controller, cancelKey }) => {
		const host = await createCliLoginHost(controller.signal)
		if (!host) return 1
		const ok = await performKimchiBrowserLogin(host, { region, selfHostedEndpoints })
		if (controller.signal.aborted) {
			console.log("Login cancelled.")
			return cancelKey() === "ctrl-c" ? 130 : 0
		}
		return ok ? 0 : 1
	})
}

async function runApiKeyMethod(): Promise<MethodResult> {
	const region = midFlowExit(await pickRegion())
	if ("exit" in region) return region.exit

	let selfHostedEndpoints: SelfHostedEndpoints | undefined
	if (region.value === "self-hosted") {
		const endpoints = midFlowExit(await promptSelfHostedConsoleEndpoints(loadConfig().selfHostedEndpoints?.console))
		if ("exit" in endpoints) return endpoints.exit
		selfHostedEndpoints = endpoints.value
	}

	const apiKey = midFlowExit(await promptKimchiApiKey())
	if ("exit" in apiKey) return apiKey.exit

	// Self-hosted derives the gateway from the discovered endpoints; a separate
	// endpoint prompt would invite a divergence that is never persisted (TUI
	// parity: the endpoint prompt is skipped for self-hosted there too).
	let endpoint = ""
	if (region.value !== "self-hosted") {
		const custom = midFlowExit(await promptKimchiEndpoint(endpointsForRegion(region.value).llmBaseUrl))
		if ("exit" in custom) return custom.exit
		endpoint = custom.value
	}

	const host = await createCliLoginHost()
	if (!host) return 1
	const ok = await performKimchiApiKeyLogin(host, {
		apiKey: apiKey.value,
		endpoint,
		region: region.value,
		selfHostedEndpoints,
	})
	return ok ? 0 : 1
}

async function runSsoMethod(): Promise<MethodResult> {
	const ssoRegions = ssoAvailableRegions()
	// Mirror the TUI: with a single tenant region there's no region selector.
	const region =
		ssoRegions.length <= 1
			? { kind: "next" as const, value: ssoRegions[0]?.id ?? loadConfig().region }
			: await pickRegion(ssoRegions)
	const picked = midFlowExit(region)
	if ("exit" in picked) return picked.exit

	setPendingOAuthRegion(picked.value)
	const config = resolveOAuthLoginConfig(picked.value)
	if (!config) {
		console.error("CAST AI SSO login is not available for the current region")
		return 1
	}

	const { controller, cancelKey, disarm } = armInFlightCancel()
	try {
		const credential = await Promise.race([
			loginWithCastAiOauth(config, createCliSsoCallbacks(controller)),
			abortedWhen(controller),
		])
		// Settle the (possibly) outstanding manual-code prompt: the manual branch
		// of loginWithCastAiOauth's race hangs otherwise. Aborted is a no-op here
		// when already aborted, and host.signal is unused by completeKimchiSsoLogin.
		controller.abort()
		disarm()

		const agentDir = requireAgentDir()
		await syncOAuthCredentialToKimchiProviders(join(agentDir, "auth.json"), join(agentDir, "models.json"), {
			...credential,
		})
		const host = await createCliLoginHost()
		if (!host) return 1
		const ok = await completeKimchiSsoLogin(host)
		return ok ? 0 : 1
	} catch (error) {
		disarm()
		// Classify by user intent: cancelKey() is set only by an actual
		// Esc/Ctrl-C/SIGINT, so the success-path teardown abort above cannot
		// misclassify a genuine failure as a cancel (exit 0/130).
		const key = cancelKey()
		if (key !== undefined || (error instanceof Error && error.message === LOGIN_CANCELLED_MESSAGE)) {
			console.log("Login cancelled.")
			return key === "ctrl-c" ? 130 : 0
		}
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			console.error("CAST AI SSO login appears to be in progress elsewhere — finish it, then retry.")
			return 1
		}
		console.error(`CAST AI SSO login failed: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}

// ---------------------------------------------------------------------------
// Login host: flow plumbing wired to the console and file stores
// ---------------------------------------------------------------------------

function requireAgentDir(): string {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) {
		throw new Error("KIMCHI_CODING_AGENT_DIR is not set; cli.ts must be entered via entry.ts")
	}
	return agentDir
}

/**
 * Build the flow host over a real model runtime and settings store (the same
 * `ModelRuntime.create` + `new ModelRegistry` pattern as the ACP server and
 * the TUI's asLoginRegistry). `setModel` persists exactly like the session's
 * `setModel(…, { persist: true })`: both write `defaultProvider`/`defaultModel`
 * to <agentDir>/settings.json through pi's SettingsManager.
 *
 * `getCurrentModel` approximates the session's active model with the persisted
 * default — close enough to decide "preserve a prior Kimchi model" vs "pick
 * the catalog default" (see applyPostLoginModel in flow.ts).
 */
async function createCliLoginHost(signal?: AbortSignal): Promise<KimchiBrowserLoginHost | undefined> {
	try {
		const agentDir = requireAgentDir()
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		})
		// Kimchi OAuth wiring mirrors the TUI login extension (pi.registerProvider
		// { oauth }) so an SSO credential activates the Kimchi providers on this
		// standalone runtime — pi's auth resolution skips providers that do not
		// declare auth.oauth.
		installKimchiOAuth(runtime)
		const settings = SettingsManager.create(process.cwd(), agentDir)
		return {
			modelRegistry: new ModelRegistry(runtime),
			setModel: (model) => {
				settings.setDefaultModelAndProvider(model.provider, model.id)
			},
			getCurrentModel: () => {
				const provider = settings.getDefaultProvider()
				const id = settings.getDefaultModel()
				return provider && id ? { provider, id } : undefined
			},
			showStatus: (message) => console.log(message),
			showError: (message) => console.error(message),
			addFeedback: (message) => console.log(message),
			onBrowserUrl: (url) => console.log(formatBrowserLoginMessage(url)),
			signal,
		}
	} catch (error) {
		console.error(`Kimchi login failed: ${error instanceof Error ? error.message : String(error)}`)
		return undefined
	}
}

// ---------------------------------------------------------------------------
// In-flight cancel (Esc / Ctrl-C during a browser wait)
// ---------------------------------------------------------------------------

type CancelKey = "escape" | "ctrl-c"

interface InFlightCancel {
	controller: AbortController
	cancelKey: () => CancelKey | undefined
	disarm: () => void
}

/**
 * Arm Esc/Ctrl-C cancellation for a browser-wait phase: clack prompts are not
 * active during the wait, so the wait owns stdin (raw mode + keypress events)
 * plus SIGINT. Esc aborts with key "escape" (exit 0 — a deliberate cancel,
 * like the TUI dialog's Esc), Ctrl-C/SIGINT with "ctrl-c" (exit 130).
 *
 * The previous raw-mode state is restored on disarm; node restores termios
 * on process exit regardless.
 */
function armInFlightCancel(): InFlightCancel {
	const controller = new AbortController()
	let key: CancelKey | undefined
	const stdin = process.stdin
	const hadRaw = typeof stdin.isRaw === "boolean" ? stdin.isRaw : undefined
	emitKeypressEvents(stdin)
	stdin.setRawMode?.(true)
	const abortWith = (pressed: CancelKey) => {
		key ??= pressed
		controller.abort()
	}
	const onKeypress = (_str: unknown, pressed: { name?: string; ctrl?: boolean } | undefined) => {
		if (pressed?.name === "escape") abortWith("escape")
		else if (pressed?.ctrl && pressed.name === "c") abortWith("ctrl-c")
	}
	const onSigint = () => abortWith("ctrl-c")
	stdin.on("keypress", onKeypress)
	process.on("SIGINT", onSigint)
	return {
		controller,
		cancelKey: () => key,
		disarm: () => {
			stdin.off("keypress", onKeypress)
			process.off("SIGINT", onSigint)
			if (hadRaw !== undefined) stdin.setRawMode?.(hadRaw)
		},
	}
}

/** Run `body` with an armed in-flight cancel; the disarm always runs. */
async function withInFlightCancel<T>(
	body: (armed: Pick<InFlightCancel, "controller" | "cancelKey">) => Promise<T>,
): Promise<T> {
	const { controller, cancelKey, disarm } = armInFlightCancel()
	try {
		return await body({ controller, cancelKey })
	} finally {
		disarm()
	}
}

/** Rejects when the controller aborts — races a flow that ignores the signal
 * (the pending callback-server wait inside loginWithCastAiOauth). */
function abortedWhen(controller: AbortController): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () => reject(new Error(LOGIN_CANCELLED_MESSAGE)), { once: true })
	})
}

// ---------------------------------------------------------------------------
// Legacy flows (non-interactive stdin, kept byte-identical for compatibility)
// ---------------------------------------------------------------------------

/**
 * The default legacy `kimchi login` for non-interactive stdin: browser login
 * against the configured region's web app, persisting the resulting API key.
 */
async function runCloudLogin(): Promise<number> {
	const s = spinner()
	s.start("Waiting for browser login…")

	let token: string
	try {
		const result = await authenticateViaBrowser()
		token = result.token
		s.stop("Browser login succeeded.")
	} catch (err) {
		s.stop("Browser login failed.")
		console.error(err instanceof Error ? err.message : String(err))
		return 1
	}

	try {
		writeApiKey(token)
	} catch (err) {
		console.error(`Failed to save API key to config: ${err instanceof Error ? err.message : String(err)}`)
		return 1
	}

	const warning = getApiKeyMismatchWarning(token)
	if (warning) console.warn(`Warning: ${warning}`)

	return 0
}

/**
 * `kimchi login <console-url>`: the same flow as the interactive `/login`
 * self-hosted path, with the console URL provided as an argument —
 *
 *   1. fetch `<console-url>/env/endpoints.json` and derive the api/llm
 *      endpoints from it (see src/self-hosted-discovery.ts),
 *   2. fall back to deriving them from the entered URL as the single base,
 *      with a clear notice, when the install predates discovery (or the
 *      document is unreachable),
 *   3. run the browser login against the console,
 *   4. persist the key with region "self-hosted" and the endpoints,
 *   5. finalize exactly like the interactive account login (models.json
 *      refresh, auth.json sync, default model).
 *
 * Authentication itself is unchanged from the interactive flow: the browser
 * handoff mints the API key and the finalization stores it.
 */
async function runSelfHostedLogin(consoleUrlArg: string): Promise<number> {
	const consoleUrl = normalizeSelfHostedBaseUrl(consoleUrlArg)
	if (!consoleUrl) {
		console.error(`Invalid console URL "${consoleUrlArg}" (expected an http(s) URL, e.g. https://kimchi.example.com)`)
		return 1
	}

	const s = spinner()
	s.start(`Checking ${consoleUrl}/env/endpoints.json…`)
	const discovery = await fetchSelfHostedEndpoints(consoleUrl)
	if (discovery.status !== "discovered") {
		s.stop("Endpoint discovery failed.")
		console.error(discoveryFailureMessage(discovery))
		return 1
	}
	s.stop(`Discovered endpoints — API ${discovery.endpoints.api}, LLM gateway ${discovery.endpoints.llm}.`)

	return runAccountLogin("self-hosted", discovery.endpoints)
}

export function getLoginHelp(): string {
	const lines: string[] = [
		"Log in to Kimchi: choose CAST AI SSO (recommended), your Kimchi account in the browser,",
		"or an API key — then pick a region. Future sessions pick up the credential automatically.",
		"Subscription logins (e.g. Anthropic, GitHub Copilot) are available via /login inside the TUI.",
		"",
		"Without an interactive terminal the command logs in via the browser directly, using the",
		"configured region (this is how scripts and ACP terminal auth use it).",
		"",
		"Pass a self-hosted console URL to log in to a standalone install instead:",
		"  kimchi login https://your-kimchi-host.example.com",
		"The API and LLM-gateway endpoints are discovered from <url>/env/endpoints.json,",
		"which the install must serve — without it there is no self-hosted login.",
	]
	return lines.join("\n")
}
