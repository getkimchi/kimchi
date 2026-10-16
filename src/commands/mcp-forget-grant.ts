/**
 * Forget a server's stored native OAuth credentials. Post-migration tokens
 * live in `<agentDir>/mcp-auth.json`, keyed `<mcpNamespace(name)>|<url>` —
 * `mcp__<name with - → _>` followed by the full URL (pi's
 * `McpOAuthCredentialStore` in extensions/mcp/oauth.ts). Deleting every key
 * carrying the server namespace forgets the grant for all URLs of that server.
 * No OS keychain is involved (that was the adapter's store).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * pi's `mcpNamespace(server)` (core/mcp-servers.ts): `mcp__` + the name with
 * `-` replaced by `_`. Not exported from the package root, so mirrored here;
 * the co-located test pins the format against the native store's keys.
 */
export function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`
}

export function forgetMcpGrant(name: string, authPath: string): { removed: number } {
	if (!existsSync(authPath)) return { removed: 0 }
	const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"))
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${authPath} is not a JSON object`)
	const states = parsed as Record<string, unknown>
	const namespace = mcpNamespace(name)
	let removed = 0
	for (const key of Object.keys(states)) {
		if (key.startsWith(`${namespace}|`)) {
			delete states[key]
			removed++
		}
	}
	if (removed > 0) writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`)
	return { removed: removed }
}

export function defaultMcpAuthPath(agentDir: string): string {
	return join(agentDir, "mcp-auth.json")
}
