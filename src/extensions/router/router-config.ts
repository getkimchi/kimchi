import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { getRegion } from "../../regions.js"
import { AUTO_MODEL_PROVIDER } from "./constants.js"

export interface RouterConfig {
	endpoint: string
	apiKey: string
}

/** The default router endpoint follows the configured region. */
export function defaultRouterEndpoint(): string {
	return getRegion(loadConfig().region).llmBaseUrl
}

export async function getRouterConfig(
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<RouterConfig | undefined> {
	const apiKey = (await modelRegistry.getApiKeyForProvider(AUTO_MODEL_PROVIDER))?.trim()
	if (!apiKey) return undefined
	return {
		endpoint: process.env.KIMCHI_ROUTER_ENDPOINT?.trim() || defaultRouterEndpoint(),
		apiKey,
	}
}
