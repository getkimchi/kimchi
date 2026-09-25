import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { resolveEndpoints } from "../../config.js"
import { AUTO_MODEL_PROVIDER } from "./constants.js"

export interface RouterConfig {
	endpoint: string
	apiKey: string
}

export async function getRouterConfig(
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<RouterConfig | undefined> {
	const apiKey = (await modelRegistry.getApiKeyForProvider(AUTO_MODEL_PROVIDER))?.trim()
	if (!apiKey) return undefined
	return {
		endpoint: process.env.KIMCHI_ROUTER_ENDPOINT?.trim() || resolveEndpoints().llmBaseUrl,
		apiKey,
	}
}
