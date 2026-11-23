import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MCP_OAUTH_STATUS_MESSAGE = "mcp-oauth-status"

type OAuthStatusMessage = Parameters<ExtensionAPI["sendMessage"]>[0]
type OAuthOutcome = { authenticated: boolean; message: string }

type PendingOAuth = {
	serverName: string
	cancelled: boolean
	resolve: (outcome: OAuthOutcome) => void
	completion: Promise<OAuthOutcome>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function authStatusDetails(message: OAuthStatusMessage): { serverName: string; authenticated: boolean } | undefined {
	if (message.customType !== MCP_OAUTH_STATUS_MESSAGE || !isRecord(message.details)) return undefined
	const { server, status } = message.details
	if (typeof server !== "string" || (status !== "authenticated" && status !== "failed")) return undefined
	return { serverName: server, authenticated: status === "authenticated" }
}

function statusMessageText(message: OAuthStatusMessage): string {
	if (typeof message.content === "string") return message.content
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
}

/** Intentional #797 scope exception for remote HTTPS redirects without
 * loopback capture. No background watcher can settle these flows. The user
 * must see the instructions, then supply the callback in a follow-up ACP
 * prompt so its auth-complete tool can finish authorization and resumed work.
 * Use the adapter's structured discriminator, never its display wording. */
function isManualHandoff(result: AgentToolResult<unknown>): boolean {
	return isRecord(result.details) && result.details.handoff === "manual"
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("MCP OAuth turn was cancelled")
}

/** The adapter exposes auth-start as a background watch plus triggerTurn message.
 * ACP must instead keep the originating tool/model run alive until that watch
 * settles. One coordinator belongs to one installed (therefore one session's)
 * adapter facade; the server key separates independent connector flows.
 *
 * Status correlation is session + server name because mcp-oauth-status has no
 * per-flow id. That is sufficient only because the adapter has this contract
 * today: backgroundAuthWatchers is one per McpExtensionState/server, and its
 * pending authentication registry coalesces same-server/share-store starts.
 * Isolated settings probes do not call this session's pi.sendMessage. If the
 * adapter later permits genuinely independent same-server watchers, it MUST
 * expose a flow id in mcp-oauth-status and this gate must match on that id. */
export class McpOAuthTurnContinuation {
	private readonly pending = new Map<string, PendingOAuth>()

	static serverNameForAuthStart(params: unknown): string | undefined {
		if (!isRecord(params) || params.action !== "auth-start" || typeof params.server !== "string") return undefined
		return params.server
	}

	async runAuthStart(
		serverName: string,
		signal: AbortSignal | undefined,
		execute: () => Promise<AgentToolResult<unknown>>,
	): Promise<AgentToolResult<unknown>> {
		const existing = this.pending.get(serverName)
		if (existing) {
			return {
				content: [
					{
						type: "text",
						text: `OAuth authentication for "${serverName}" is already in progress. Wait for the original browser flow instead of starting another.`,
					},
				],
				details: { error: "oauth_already_pending", server: serverName },
				isError: true,
			}
		}
		let resolveCompletion!: (outcome: OAuthOutcome) => void
		const completion = new Promise<OAuthOutcome>((resolve) => {
			resolveCompletion = resolve
		})
		const pending: PendingOAuth = { serverName, cancelled: false, resolve: resolveCompletion, completion }
		// Register before execution: a local OAuth callback is allowed to complete
		// before auth-start returns its browser instructions.
		this.pending.set(serverName, pending)
		const markCancelled = () => {
			pending.cancelled = true
		}
		signal?.addEventListener("abort", markCancelled, { once: true })
		try {
			let result: AgentToolResult<unknown>
			try {
				result = await execute()
			} catch (error) {
				if (signal?.aborted) pending.cancelled = true
				else this.pending.delete(serverName)
				throw error
			}
			if (signal?.aborted) throw abortError(signal)
			if (
				!isRecord(result.details) ||
				typeof result.details.authorizationUrl !== "string" ||
				result.details.authenticated === true ||
				isManualHandoff(result)
			) {
				this.pending.delete(serverName)
				return result
			}

			let rejectAborted!: (error: Error) => void
			const aborted = new Promise<never>((_, reject) => {
				rejectAborted = reject
			})
			const onAbort = () => {
				if (signal) rejectAborted(abortError(signal))
			}
			signal?.addEventListener("abort", onAbort, { once: true })
			let outcome: OAuthOutcome
			try {
				outcome = await Promise.race([pending.completion, aborted])
			} catch (error) {
				// Retain a cancelled tombstone, not a second timer or a stale grant:
				// this stops the old outcome resuming a retry. The adapter bounds
				// every watch by MANUAL_AUTH_TIMEOUT_MS (5m), rejects authenticate,
				// and emits a terminal failed status, which clears this entry below.
				// If upstream removes that bound, this coordinator needs an equivalent
				// tombstone TTL plus status correlation before another start is allowed.
				pending.cancelled = true
				throw error
			} finally {
				signal?.removeEventListener("abort", onAbort)
			}
			this.pending.delete(serverName)
			const details = isRecord(result.details) ? result.details : {}
			return {
				...result,
				content: [{ type: "text", text: outcome.message }],
				isError: !outcome.authenticated,
				details: {
					...details,
					authenticated: outcome.authenticated,
					...(outcome.authenticated ? {} : { error: "oauth_failed" }),
				},
			}
		} finally {
			signal?.removeEventListener("abort", markCancelled)
		}
	}

	/** Consume the sole same-server watcher status owned by this session. Other
	 * OAuth sources keep the ordinary sendMessage path AND triggerTurn options;
	 * see the class comment for the single-live-flow invariant that makes server
	 * matching sufficient. A failed status is the adapter's bounded terminal
	 * signal for both failed and abandoned/cancelled authorizations. */
	consumeStatusMessage(message: OAuthStatusMessage): boolean {
		const details = authStatusDetails(message)
		if (!details) return false
		const pending = this.pending.get(details.serverName)
		if (!pending) return false
		this.pending.delete(details.serverName)
		if (!pending.cancelled) {
			pending.resolve({
				authenticated: details.authenticated,
				message: details.authenticated
					? `OAuth authentication successful for "${details.serverName}".`
					: statusMessageText(message) || `OAuth authentication failed for "${details.serverName}".`,
			})
		}
		return true
	}

	/** Release a tool wait during session disposal. The adapter's own runtime
	 * shutdown rejects its browser watch; no late status can find this map. */
	shutdown(): void {
		const pending = [...this.pending.values()]
		this.pending.clear()
		for (const flow of pending) {
			if (!flow.cancelled) {
				flow.resolve({ authenticated: false, message: `OAuth authentication ended for "${flow.serverName}".` })
			}
		}
	}
}
