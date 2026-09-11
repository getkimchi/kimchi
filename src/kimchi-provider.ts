// Provider id wants a home without imports: login/flow.ts is the obvious
// owner but it imports models.ts, and models.ts needs the id on refresh
// failure — any heavier owner would cycle. Keep this module dependency-free.

export const KIMCHI_PROVIDER_ID = "kimchi-dev"

/** True for any kimchi-managed provider (kimchi-dev or kimchi-dev/* sub-providers). */
export function isKimchiProvider(provider: string): boolean {
	return provider.startsWith(KIMCHI_PROVIDER_ID)
}
