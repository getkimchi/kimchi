// ACP extension method handler for the session status snapshot.
//
// Wire name: `_kimchi.dev/session_status` — the vendor-namespaced method
// Studio renders as a native status surface (ADR
// docs/adr/0001-session-status-acp-ext-method.md). Session-scoped on
// purpose: session name/id, cwd, model and MCP counts are per-session,
// unlike auth_status which is deliberately sessionless.

import { RequestError } from "@agentclientprotocol/sdk"
import type { StatusSnapshot } from "../../../extensions/status/snapshot.js"
import type { StatusProvider } from "../status-provider-registry.js"

/**
 * Handler for the `_kimchi.dev/session_status` ACP extension method.
 *
 * Validates params, looks up the session's snapshot gatherer in the
 * status-provider registry, and returns the structured snapshot. Pull-only:
 * every field is re-read live per call except identity (email/organization),
 * which comes from the extension's background fetch, and mcp, which comes
 * from the last pi-mcp-adapter status event — both absent until they land.
 *
 * Follows the set_session_title precedent: invalidParams for a missing/empty
 * or unknown sessionId. A logged-out user is not an error — the snapshot
 * reports login.method "none".
 */
export function handleSessionStatus(
	getProvider: (sessionId: string) => StatusProvider | undefined,
	params: Record<string, unknown>,
): StatusSnapshot {
	const sessionId = params.sessionId
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "sessionId is required and must be a non-empty string")
	}
	const provider = getProvider(sessionId)
	if (!provider) {
		throw RequestError.invalidParams(undefined, `unknown sessionId ${sessionId}`)
	}
	return provider()
}
