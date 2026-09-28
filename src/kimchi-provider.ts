// Provider id wants a home without imports: login/flow.ts is the obvious
// owner but it imports models.ts, and models.ts needs the id on refresh
// failure — any heavier owner would cycle. Keep this module dependency-free.

export const KIMCHI_PROVIDER_ID = "kimchi-dev"
const KIMCHI_EXPERIMENTAL_PROVIDER_ID = "kimchi-experimental"

/** True for every Kimchi-managed provider, including experimental models. */
export function isKimchiProvider(provider: string): boolean {
	return (
		provider === KIMCHI_PROVIDER_ID ||
		provider.startsWith(`${KIMCHI_PROVIDER_ID}/`) ||
		provider === KIMCHI_EXPERIMENTAL_PROVIDER_ID
	)
}
