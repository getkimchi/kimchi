import { join } from "node:path"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { prepareActivePromptKimchiCredential } from "../../auth/active-prompt-refresh.js"
import { loadConfig } from "../../config.js"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "../../kimchi-provider.js"
import { chatCompletionsApi } from "../../models.js"
import { refreshBillingStatusFromConfig } from "../billing/status.js"
import { createGatewayCodexProvider, registerGatewayCodexApi } from "./codex-gateway.js"
import { createKimchiProviderOAuth } from "./flow.js"

export default function loginExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return

	// Builtin providers are disabled globally; explicitly restore the approved subscription provider.
	registerBunOAuthFlows()
	registerGatewayCodexApi()
	pi.registerProvider(createGatewayCodexProvider())

	// Apply a custom llmEndpoint as an in-memory baseUrl override for the kimchi-dev provider.
	// This routes chat requests to the override even when the metadata refresh falls back to the
	// cached (gateway) models.json — without persisting a project-local endpoint into the global
	// models.json. Only set when explicitly configured so the default gateway keeps flowing.
	const { customLlmEndpoint } = loadConfig()
	const authPath = join(agentDir, "auth.json")
	const kimchiOAuth = createKimchiProviderOAuth(authPath)
	const sessionOAuthByRegistry = new WeakMap<object, typeof kimchiOAuth>()
	const sessionOAuthFor = (owner: object) => {
		let oauth = sessionOAuthByRegistry.get(owner)
		if (!oauth) {
			oauth = createKimchiProviderOAuth(authPath, owner)
			sessionOAuthByRegistry.set(owner, oauth)
		}
		return oauth
	}

	const kimchiProvider: Parameters<typeof pi.registerProvider>[1] = { oauth: kimchiOAuth }
	if (customLlmEndpoint) {
		kimchiProvider.baseUrl = chatCompletionsApi(customLlmEndpoint)
	}
	pi.registerProvider(KIMCHI_PROVIDER_ID, kimchiProvider)

	pi.on("input", async (event, ctx) => {
		// Limit the preflight to original TUI prompts. ACP refreshes at its
		// session/prompt adapter, where a revoked grant becomes -32000 instead
		// of an extension error. Other sources retain their existing auth path.
		if (event.source !== "interactive" || ctx.mode !== "tui") return
		const preparation = await prepareActivePromptKimchiCredential(
			{ authPath, modelsPath: join(agentDir, "models.json") },
			(runtime, owner) => {
				runtime.registerProvider(KIMCHI_PROVIDER_ID, {
					...kimchiProvider,
					oauth: sessionOAuthFor(owner ?? ctx.modelRegistry),
				})
			},
			ctx.model?.provider,
			ctx.modelRegistry,
		)
		if (preparation === "oauth_revoked") {
			ctx.ui.notify("OAuth refresh was rejected. Run /login to sign in again.", "error")
			return { action: "handled" as const }
		}
		if (preparation === "credential_sync_failed") {
			ctx.ui.notify(
				"OAuth refresh succeeded, but the active credential could not be saved. Retry this prompt; sign-in is not required.",
				"error",
			)
			return { action: "handled" as const }
		}
	})

	// Register the same OAuth handler for every Kimchi-managed sub-provider
	// (kimchi-dev/* and kimchi-experimental) so that authStorage.getApiKey can
	// resolve their credentials (stored as type: "oauth"). This runs on every
	// session_start because sub-providers may not exist yet at initial load
	// (they're created by updateModelsConfig from the metadata API).
	pi.on("session_start", (_event, ctx) => {
		if (loadConfig().apiKey) {
			void refreshBillingStatusFromConfig({ mode: "forced" })
		}
		if (ctx.mode !== "tui") {
			// ACP binds callbacks to its session runtime after extension loading.
			// Do not replace that owner with the TUI registry identity here.
			return
		}
		const sessionOAuth = sessionOAuthFor(ctx.modelRegistry)
		pi.registerProvider(KIMCHI_PROVIDER_ID, { ...kimchiProvider, oauth: sessionOAuth })
		const subProviders = new Set(
			ctx.modelRegistry
				.getAll()
				.map((m) => m.provider)
				.filter((p) => p !== KIMCHI_PROVIDER_ID && isKimchiProvider(p)),
		)
		for (const subProviderId of subProviders) {
			pi.registerProvider(subProviderId, { oauth: sessionOAuth })
		}
	})
}
