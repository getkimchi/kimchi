/**
 * Transient MCP tool probing on pi 1.3's native client stack
 * (`@earendil-works/pi-mcp`). Replaces the pi-mcp-adapter-based probe: the
 * public shape (`McpProbe.probeTools` → `ProbeResult`) is kept for the
 * `kimchi mcp probe` CLI and the `_kimchi.dev/probe_mcp_server` ACP method.
 *
 * Auth: HTTP probes reuse stored native OAuth grants — the same
 * `<agentDir>/mcp-auth.json` store pi's `/mcp` sign-in flow writes, keyed
 * `mcp__<name>|<url>`. A stored grant is attached through pi's own auth
 * provider (access token + refresh on 401/expiry), so a signed-in server
 * probes as connected. A required sign-in maps to `needsAuth: true` and the
 * user signs in via /mcp or `kimchi mcp login`. Pass `authenticate: false` to
 * skip stored credentials entirely (anonymous probe).
 */

import { createMcpAuthProvider, type McpAuthProvider, McpOAuthCredentialStore } from "@earendil-works/pi-coding-agent"
import type { Tool } from "@earendil-works/pi-mcp"
import {
	McpAuthRequiredError,
	McpClient,
	McpHttpError,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp"
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth"
import type { ServerEntry } from "./types.js"

export type ProbeTool = Pick<Tool, "name"> &
	Partial<Pick<Tool, "title" | "description" | "inputSchema" | "annotations">>

export interface ProbeResult {
	tools: ProbeTool[]
	needsAuth: boolean
	error: string | null
}

export interface McpProbeOptions {
	/**
	 * Use stored OAuth credentials when present (default). `false` probes
	 * anonymously — useful for checking whether a server requires sign-in.
	 */
	authenticate?: boolean
	cwd?: string
	signal?: AbortSignal
}

export interface McpProbe {
	probeTools(name: string, definition: ServerEntry, options?: McpProbeOptions): Promise<ProbeResult>
}

const PROBE_TIMEOUT_MS = 10_000

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/**
 * Best-effort stored-grant auth provider for an HTTP server, or undefined when
 * no grant is stored (anonymous probe). Uses pi's credential store and auth
 * provider so refresh and token rotation follow the same code path as real
 * sessions; a required sign-in surfaces as `McpOAuthAuthorizationRequiredError`
 * (mapped to `needsAuth`), never as an interactive prompt.
 */
async function storedGrantProvider(name: string, definition: ServerEntry): Promise<McpAuthProvider | undefined> {
	if (typeof definition.url !== "string") return undefined
	try {
		const serverStore = new McpOAuthCredentialStore().forServer(name, definition.url)
		const state = await serverStore.load()
		if (state?.tokens === undefined) return undefined
		const oauth = isRecord(definition.oauth) ? definition.oauth : {}
		const client = state.clientInformation
		return createMcpAuthProvider({
			serverUrl: definition.url,
			store: serverStore,
			settings: () => ({
				...(client?.client_id !== undefined ? { clientId: client.client_id } : {}),
				...(client?.client_secret !== undefined ? { clientSecret: client.client_secret } : {}),
				...(typeof oauth.clientName === "string" ? { clientName: oauth.clientName } : {}),
				...(oauth.clientRegistration === "cimd" || oauth.clientRegistration === "dcr"
					? { clientRegistration: oauth.clientRegistration }
					: {}),
				...(typeof oauth.authServerMetadataUrl === "string"
					? { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }
					: {}),
				...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
			}),
			// Non-interactive: the probe never opens a sign-in flow.
			onChallenge: () => {},
		})
	} catch {
		// Unreadable store or a malformed grant — fall back to an anonymous probe.
		return undefined
	}
}

export class UpstreamMcpProbe implements McpProbe {
	async probeTools(name: string, definition: ServerEntry, options: McpProbeOptions = {}): Promise<ProbeResult> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
		const outerSignal = options.signal
		if (outerSignal) {
			if (outerSignal.aborted) controller.abort()
			else outerSignal.addEventListener("abort", () => controller.abort(), { once: true })
		}
		const useStoredAuth = options.authenticate !== false
		let authProvider: McpAuthProvider | undefined

		try {
			if (useStoredAuth) authProvider = await storedGrantProvider(name, definition)
			const transport =
				typeof definition.url === "string"
					? new StreamableHttpTransport({
							url: definition.url,
							...(typeof definition.headers === "object" && definition.headers !== null
								? { headers: definition.headers as Record<string, string> }
								: {}),
							...(authProvider ? { authProvider } : {}),
						})
					: new StdioTransport({
							command: definition.command as string,
							args: Array.isArray(definition.args) ? (definition.args as string[]) : [],
							...(typeof definition.cwd === "string" ? { cwd: definition.cwd } : { cwd: options.cwd }),
							...(typeof definition.env === "object" && definition.env !== null
								? { env: definition.env as Record<string, string> }
								: {}),
							stderr: "pipe",
						})
			const client = new McpClient({ name: "kimchi-probe", version: "1.0.0", requestTimeoutMs: PROBE_TIMEOUT_MS })
			try {
				await client.connect(transport)
				const tools = await client.listTools({ signal: controller.signal, timeoutMs: PROBE_TIMEOUT_MS })
				return {
					tools: tools.map((tool) => ({
						name: tool.name,
						...(tool.title !== undefined ? { title: tool.title } : {}),
						...(tool.description !== undefined ? { description: tool.description } : {}),
						...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
						...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
					})),
					needsAuth: false,
					error: null,
				}
			} finally {
				await client.close().catch(() => {})
			}
		} catch (error: unknown) {
			if (
				error instanceof McpAuthRequiredError ||
				error instanceof McpOAuthAuthorizationRequiredError ||
				(error instanceof McpHttpError && error.status === 401)
			) {
				return { tools: [], needsAuth: true, error: null }
			}
			return { tools: [], needsAuth: false, error: errorMessage(error) }
		} finally {
			clearTimeout(timer)
			// Let a background refresh finish saving rotated tokens before exit.
			await authProvider?.settled().catch(() => {})
		}
	}
}
