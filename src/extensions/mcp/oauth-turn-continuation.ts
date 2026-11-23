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

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("MCP OAuth turn was cancelled")
}

/** The adapter exposes auth-start as a background watch plus triggerTurn message.
 * ACP must instead keep the originating tool/model run alive until that watch
 * settles. One coordinator belongs to one installed (therefore one session's)
 * adapter facade; the server key separates independent connector flows. */
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
				result.details.authenticated === true
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
				// Retain a cancelled tombstone until the adapter's watcher reports.
				// Its late status is consumed rather than becoming a new agent turn.
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

	/** Consume a watcher status only when it belongs to an auth-start gated by
	 * this session. Other OAuth sources (probes, settings, slash commands) pass
	 * through the adapter's ordinary sendMessage behavior unchanged. */
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
