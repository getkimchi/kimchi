// Provider id wants a home without imports: login/flow.ts is the obvious
// owner but it imports models.ts, and models.ts needs the id on refresh
// failure — any heavier owner would cycle. Keep this module dependency-free.

export const KIMCHI_PROVIDER_ID = "kimchi-dev"
const KIMCHI_EXPERIMENTAL_PROVIDER_ID = "kimchi-experimental"

/**
 * ChatGPT-subscription models served through the gateway. Lives under the
 * `kimchi-dev/` prefix so `/model` shows it next to the other gateway rows, but
 * it authenticates with the user's ChatGPT login (plus the Kimchi key as a
 * header added at request time), so it is not a Kimchi-key provider.
 */
export const CODEX_PROVIDER_ID = `${KIMCHI_PROVIDER_ID}/openai-codex`

/** Pi's own Codex provider id (direct to chatgpt.com); never offered. */
export const PI_CODEX_PROVIDER_ID = "openai-codex"

/**
 * True for every provider that takes the Kimchi credential, including
 * experimental models. Excludes the Codex block, which keeps its ChatGPT login.
 */
export function isKimchiProvider(provider: string): boolean {
	if (provider === CODEX_PROVIDER_ID) return false
	return (
		provider === KIMCHI_PROVIDER_ID ||
		provider.startsWith(`${KIMCHI_PROVIDER_ID}/`) ||
		provider === KIMCHI_EXPERIMENTAL_PROVIDER_ID
	)
}
