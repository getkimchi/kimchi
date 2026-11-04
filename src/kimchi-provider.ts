// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
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
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
