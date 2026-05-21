import { deleteRemoteSession, getMe, listRemoteSessions } from "../api/index.js"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import type { RemoteSessionSummary } from "../types.js"
import { createSessionsPanel } from "../ui/sessions-panel.js"
import type { SessionPickerResult } from "../ui/sessions-panel.js"
import type { SessionRow } from "../ui/sessions-table.js"
import { runAttach } from "./attach.js"
import { runConnect } from "./connect.js"
import { info, warn } from "./errors.js"
import { readSessionId, readSessionName } from "./session-resolve.js"
import type { TeleportContext } from "./types.js"

export async function runListSessions(ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper

	let creatorId: string | undefined
	try {
		const me = await getMe(ctx.apiKey, { endpoint: ctx.endpoint })
		creatorId = me.id
	} catch (err) {
		warn(
			ctx,
			`Could not fetch current user: ${err instanceof Error ? err.message : String(err)}. Listing all sessions.`,
		)
	}

	let serverSessions: RemoteSessionSummary[] = []
	try {
		serverSessions = await listRemoteSessions(ctx.apiKey, {
			endpoint: ctx.endpoint,
			signal: ctx.signal,
			creatorId,
		})
	} catch (err) {
		warn(
			ctx,
			`Could not fetch server sessions: ${err instanceof Error ? err.message : String(err)}. Showing local state only.`,
		)
	}

	const knownIds = new Set<string>()
	const rows: SessionRow[] = []

	if (!wrapper.isForegroundHomeBase) {
		const fg = wrapper.foreground as unknown as RemoteAgentSession
		const id = readSessionId(fg)
		if (id) {
			const match = serverSessions.find((s) => s.id === id)
			rows.push({
				id,
				name: readSessionName(fg) ?? match?.name ?? "",
				host: match?.host,
				state: "foreground",
				status: match?.status,
				createdAt: match?.createdAt,
				lastActivityAt: match?.lastActivityAt,
			})
			knownIds.add(id)
		}
	}

	for (const [id, remote] of wrapper.getDetached()) {
		const match = serverSessions.find((s) => s.id === id)
		rows.push({
			id,
			name: readSessionName(remote) ?? match?.name ?? "",
			host: match?.host,
			state: "detached (this kimchi)",
			status: match?.status,
			createdAt: match?.createdAt,
			lastActivityAt: match?.lastActivityAt,
		})
		knownIds.add(id)
	}

	for (const s of serverSessions) {
		if (knownIds.has(s.id)) continue
		rows.push({
			id: s.id,
			name: s.name,
			host: s.host,
			state: s.hasConnectedClient ? "active elsewhere" : "detached",
			status: s.status,
			createdAt: s.createdAt,
			lastActivityAt: s.lastActivityAt,
		})
	}

	if (rows.length === 0) {
		info(ctx, "No remote sessions.")
		return
	}

	const result = await ctx.ui.custom<SessionPickerResult | undefined>(
		(tui, _theme, _keybindings, done) => {
			return createSessionsPanel(rows, tui, done)
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
	)

	if (!result) return

	if (result.action === "attach") {
		await runAttach({ target: result.sessionId }, ctx)
	} else if (result.action === "connect") {
		await runConnect({ target: result.sessionId }, ctx)
	} else if (result.action === "delete") {
		const confirmed = await ctx.ui.confirm(
			"Delete session",
			`Are you sure you want to delete session "${result.sessionId}"?`,
		)
		if (!confirmed) return
		try {
			await deleteRemoteSession(ctx.apiKey, result.sessionId, { endpoint: ctx.endpoint })
			info(ctx, `Session "${result.sessionId}" deleted.`)
		} catch (err) {
			warn(ctx, `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}
