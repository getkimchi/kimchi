import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { listRemoteSessions } from "../api/index.js"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import type { RemoteSessionStatus, RemoteSessionSummary } from "../types.js"
import { refuse } from "./errors.js"
import type { TeleportContext } from "./types.js"

export function readSessionId(session: AgentSession | RemoteAgentSession): string | undefined {
	const id = (session as unknown as { sessionId?: unknown }).sessionId
	return typeof id === "string" && id.length > 0 ? id : undefined
}

export function readSessionName(session: AgentSession | RemoteAgentSession): string | undefined {
	const name = (session as unknown as { sessionName?: unknown }).sessionName
	return typeof name === "string" && name.length > 0 ? name : undefined
}

function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
	if (m === 0) return n
	if (n === 0) return m
	const dp: number[] = new Array(n + 1)
	for (let j = 0; j <= n; j++) dp[j] = j
	for (let i = 1; i <= m; i++) {
		let prev = dp[0]
		dp[0] = i
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j]
			dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1
			prev = tmp
		}
	}
	return dp[n]
}

function findCloseMatches(target: string, sessions: RemoteSessionSummary[]): RemoteSessionSummary[] {
	return sessions.filter((s) => s.name && levenshtein(s.name.toLowerCase(), target.toLowerCase()) <= 2).slice(0, 3)
}

export async function resolveSessionTarget(
	target: string,
	ctx: TeleportContext,
): Promise<{ sessionId: string; status?: RemoteSessionStatus; knownLocally: boolean }> {
	const wrapper = ctx.wrapper
	for (const [id, remote] of wrapper.getDetached()) {
		if (id === target || readSessionName(remote) === target) {
			return { sessionId: id, knownLocally: true }
		}
	}

	let sessions: RemoteSessionSummary[]
	try {
		sessions = await listRemoteSessions(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Could not look up sessions: ${err instanceof Error ? err.message : String(err)}`)
	}
	const match = sessions.find((s) => s.id === target || s.name === target)
	if (!match) {
		const close = findCloseMatches(target, sessions)
		const hint = close.length > 0 ? ` Did you mean: ${close.map((s) => s.name).join(", ")}?` : ""
		refuse(ctx, `No remote session matching "${target}".${hint}`)
	}
	if (match.status === "completed") {
		refuse(ctx, `Session "${target}" has completed and is no longer reachable.`)
	}
	return { sessionId: match.id, status: match.status, knownLocally: false }
}
