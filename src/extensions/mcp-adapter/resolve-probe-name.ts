import { randomUUID } from "node:crypto"
import { getAuthEntry } from "./mcp-auth.js"
import type { ServerEntry } from "./types.js"

/**
 * Decide which name to use as the OAuth token-store key during a probe.
 *
 * The token store is keyed by server name. If an auth entry already exists
 * under `name` for a *different* URL — e.g. the user edited the server's
 * URL but kept the name — probing with the real name would overwrite the
 * real server's stored credentials. To avoid that, fall back to a
 * throwaway `__probe_<uuid>` name; the caller cleans it up with
 * removeAuthEntry() in its finally block, so the real server's tokens are
 * never overwritten and the store never accumulates `__probe_*` entries.
 *
 * The real name is used in every other case:
 * - No stored entry: new server. The first probe persists tokens under
 *   the real name so a repeat probe finds them.
 * - Stored entry without a serverUrl: residue from an incomplete OAuth
 *   flow (only oauthState/codeVerifier were saved, no tokens). The real
 *   name lets the flow complete and save its tokens to the correct entry —
 *   a throwaway's tokens would be deleted by the caller's finally cleanup,
 *   looping every subsequent probe on needsAuth.
 * - Stored URL matches: repeat probe of an authorized server. Stored
 *   tokens are found and the browser flow is skipped.
 */
export function resolveProbeName(name: string, definition: ServerEntry): string {
	const existing = getAuthEntry(name)
	// No stored entry: new server — use the real name so the first probe
	// persists tokens under it and a repeat probe finds them.
	if (!existing) return name
	// No stored serverUrl: the entry is residue from an incomplete OAuth
	// flow (only oauthState/codeVerifier were saved, no tokens). Use the
	// real name so the flow can complete and save tokens to the correct
	// entry — a throwaway name's tokens would be deleted by the caller's
	// finally cleanup, leaving every subsequent probe with needsAuth: true.
	if (!existing.serverUrl) return name
	// URL matches: repeat probe of an authorized server — reuse the name so
	// stored tokens are found and the browser flow is skipped.
	if (existing.serverUrl === definition.url) return name
	// Entry exists for a different URL — isolate the probe's credentials
	// under a throwaway name so the real server's tokens are never
	// overwritten.
	return `__probe_${randomUUID()}`
}
