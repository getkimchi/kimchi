/**
 * Patches the upstream pi SDK's `/login` slash command to run Kimchi's browser
 * authentication flow instead of the generic OAuth provider selector.
 *
 * This module is imported for side effects. It must be loaded **before** any
 * `InteractiveMode` instance is constructed so the prototype patch takes effect.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { Spacer, Text } from "@earendil-works/pi-tui"
import { authenticateViaBrowser } from "./cli-auth/index.js"
import { writeApiKey } from "./config.js"

const KIMCHI_PROVIDER_ID = "kimchi-dev"
const KIMCHI_DEFAULT_MODEL_ID = "kimi-k2.6"

// ---------------------------------------------------------------------------
// Intercept the upstream login flow and redirect to Kimchi browser auth
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

async function patchedShowOAuthSelector(this: InteractiveMode, mode: "login" | "logout") {
	if (mode === "login") {
		await handleKimchiLogin(this)
		return
	}
	return oauthDelegate.original.call(this, mode)
}

// Apply patch on module load
applyLoginCommandPatch()
