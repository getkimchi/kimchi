import { InMemoryModelsStore } from "@earendil-works/pi-ai"
import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent"
import { isKimchiProvider } from "./kimchi-provider.js"
import {
	autoModelConfig,
	buildModelsConfig,
	discoverModelsConfig,
	isTransientModelsError,
	type ModelMetadata,
} from "./models.js"
import { discoverOllamaProvider, ollamaModelsToMetadata, resolveOllamaHost } from "./ollama.js"

export async function discoverEnvironmentModels(
	modelsPath: string,
	apiKey: string,
	options: { endpoint?: string; experimental: boolean },
) {
	let models: ModelMetadata[] = []
	let providers = buildModelsConfig([], options.endpoint).providers
	let refreshed = false
	try {
		// The shared cache belongs to the config account, not this override.
		const discovered = await discoverModelsConfig(modelsPath, apiKey, { ...options, allowCachedFallback: false })
		;({ models, providers, refreshed } = discovered)
	} catch (error) {
		if (!isTransientModelsError(error)) throw error
		console.warn(
			`Could not load the model list right now (${error.message}). Continuing; models will refresh once the service is reachable.`,
		)
	}
	const root = providers["kimchi-dev"]
	if (options.experimental) {
		providers["kimchi-experimental"] = { ...root, baseUrl: "https://llm.kimchi.dev/experimental/openai/v1" }
	}
	providers["kimchi-dev"] = { ...root, models: [...(root.models ?? []), autoModelConfig(models)] }
	const ollama = await discoverOllamaProvider(resolveOllamaHost())
	providers.ollama = ollama
	return {
		providers,
		models: [...models, ...ollamaModelsToMetadata(ollama.models)],
		ollamaModels: ollama.models,
		refreshed,
	}
}

/**
 * Decorate Pi's runtime factory because upstream main() owns TUI runtime creation.
 * ACP and SDK sessions use the same factory. Provider overlays and runtime keys
 * survive registry refreshes without changing shared models.json or auth.json.
 */
export function withEnvironmentModels(
	create: typeof ModelRuntime.create,
	apiKey: string,
	providers: Record<string, ProviderConfig>,
	rediscover?: () => ReturnType<typeof discoverEnvironmentModels>,
): typeof ModelRuntime.create {
	return async (options = {}) => {
		const runtime = await create({ ...options, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false })
		let activeProviders = providers
		let recover = rediscover
		const hiddenProviders = new Set<string>()
		const refresh = runtime.refresh.bind(runtime)
		runtime.refresh = async (refreshOptions) => {
			// Login and reload may recover a failed startup discovery. Registration
			// itself triggers offline refreshes, which must not retry discovery.
			if (recover && (refreshOptions?.allowNetwork ?? options.allowModelNetwork ?? true)) {
				const discovered = await recover()
				if (discovered.refreshed) {
					activeProviders = discovered.providers
					for (const providerId of Object.keys(activeProviders).filter(isKimchiProvider)) {
						await runtime.setRuntimeApiKey(providerId, apiKey, { signal: refreshOptions?.signal })
					}
					for (const [providerId, config] of Object.entries(activeProviders)) {
						runtime.registerProvider(providerId, config)
					}
					recover = undefined
				}
			}
			const result = await refresh(refreshOptions)
			// Another process can add config-account providers while this session
			// is running. Keep those out of this account's catalog on /reload too.
			for (const provider of runtime.getProviders()) {
				if (isKimchiProvider(provider.id) && !activeProviders[provider.id] && !hiddenProviders.has(provider.id)) {
					hiddenProviders.add(provider.id)
					runtime.registerProvider(provider.id, { models: [] })
					await runtime.setRuntimeApiKey(provider.id, apiKey, { signal: refreshOptions?.signal })
				}
			}
			return result
		}
		const kimchiProviderIds = new Set([
			...runtime
				.getProviders()
				.map((provider) => provider.id)
				.filter(isKimchiProvider),
			...Object.keys(providers).filter(isKimchiProvider),
		])
		// Seed auth before provider registration starts availability refreshes.
		for (const providerId of kimchiProviderIds) {
			await runtime.setRuntimeApiKey(providerId, apiKey, { signal: options.signal })
		}
		for (const [providerId, config] of Object.entries(providers)) {
			runtime.registerProvider(providerId, config)
		}
		await runtime.refresh({ allowNetwork: false, signal: options.signal })
		return runtime
	}
}

export function installEnvironmentModels(
	apiKey: string,
	providers: Record<string, ProviderConfig>,
	rediscover?: () => ReturnType<typeof discoverEnvironmentModels>,
): void {
	ModelRuntime.create = withEnvironmentModels(ModelRuntime.create.bind(ModelRuntime), apiKey, providers, rediscover)
}
