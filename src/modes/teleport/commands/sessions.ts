import {
	authenticateRemoteSession,
	deleteRemoteSession,
	getMe,
	listRemoteSessions,
	renameRemoteSession,
} from "../api/index.js"
import type { RemoteSessionSummary } from "../types.js"
import { type SessionsPanel, createSessionsPanel } from "../ui/sessions-panel.js"
import type { SessionPickerResult } from "../ui/sessions-panel.js"
import type { SessionRow, SessionRowState } from "../ui/sessions-table.js"
import { runAttach } from "./attach.js"
import { runConnect } from "./connect.js"
import { info, warn } from "./errors.js"
import { listTmuxSessions, runSshCommandWithOutput } from "./teleport-helpers.js"
import { SANDBOX_USER, type TeleportContext } from "./types.js"

// ── Session row cache ──────────────────────────────────────────────

let cachedRows: SessionRow[] | undefined

/** Clear the session row cache. Exposed for testing. */
export function clearSessionCache(): void {
	cachedRows = undefined
}

// ── Helpers ────────────────────────────────────────────────────────

function buildRow(s: RemoteSessionSummary, lastSessionId?: string): SessionRow {
	return {
		id: s.id,
		name: s.name,
		host: s.host,
		state: (s.id === lastSessionId
			? "active (this kimchi)"
			: s.hasConnectedClient
				? "active elsewhere"
				: "available") as SessionRowState,
		status: s.status,
		createdAt: s.createdAt,
		lastActivityAt: s.lastActivityAt,
	}
}

/** Run `fn` for each item with at most `limit` running concurrently. */
async function parallelMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let idx = 0
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (idx < items.length) {
			const i = idx++
			await fn(items[i])
		}
	})
	await Promise.all(workers)
}

/**
 * Fetch server sessions via HTTP, then probe tmux sessions on active
 * sandboxes with a concurrency limit of 3.
 *
 * Calls `onUpdate` after each meaningful change so the UI can refresh.
 */
async function fetchSessionsAndTmux(
	ctx: TeleportContext,
	onUpdate: (rows: SessionRow[]) => void,
): Promise<SessionRow[]> {
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
		warn(ctx, `Could not fetch server sessions: ${err instanceof Error ? err.message : String(err)}.`)
	}

	// Build base rows (fast — no SSH) and notify immediately.
	const rows = serverSessions.map((s) => buildRow(s, ctx.lastSessionId))
	onUpdate(rows)

	// Identify which rows need tmux probing.
	const probeTargets = rows
		.map((row, i) => ({ row, session: serverSessions[i] }))
		.filter(({ session }) => session.status === "active" && session.host)

	// Fetch tmux sessions, 3 at a time, updating the UI as each resolves.
	const TMUX_CONCURRENCY = 3
	await parallelMap(probeTargets, TMUX_CONCURRENCY, async ({ row, session }) => {
		try {
			const auth = await authenticateRemoteSession(
				session.id,
				ctx.apiKey,
				session.name || `Remote session for ${session.id.slice(0, 8)}`,
				{ endpoint: ctx.endpoint },
			)
			const tmux = await listTmuxSessions({
				remoteHost: auth.host,
				remoteUser: SANDBOX_USER,
				authToken: auth.connectToken,
				signal: ctx.signal,
			})
			if (tmux.length > 0) {
				row.tmuxSessions = tmux
				onUpdate(rows)
			}
		} catch {
			// Non-fatal.
		}
	})

	return rows
}

/**
 * Merge fresh server session data into existing rows WITHOUT removing
 * tmux info that was already loaded. Only adds new sessions and updates
 * metadata (state, status, timestamps). Tmux data is merged when the
 * tmux probes complete separately.
 */
function mergeServerData(existing: SessionRow[], fresh: SessionRow[]): SessionRow[] {
	const existingMap = new Map(existing.map((r) => [r.id, r]))
	const merged: SessionRow[] = []
	for (const f of fresh) {
		const prev = existingMap.get(f.id)
		merged.push({
			...f,
			// Preserve previously-loaded tmux sessions.
			tmuxSessions: prev?.tmuxSessions ?? f.tmuxSessions,
		})
	}
	return merged
}

// ── Command ────────────────────────────────────────────────────────

export async function runListSessions(ctx: TeleportContext): Promise<void> {
	// Always show the panel immediately — populate it as data arrives.
	const initialRows = cachedRows ?? []

	let panelRef: SessionsPanel | undefined
	let panelDismissed = false

	const updatePanel = (rows: SessionRow[]) => {
		if (!panelDismissed && panelRef) {
			panelRef.updateRows(rows)
		}
	}

	// Start the fetch. It will progressively update the panel.
	const fetchPromise = (async () => {
		try {
			const freshRows = await fetchSessionsAndTmux(ctx, (rows) => {
				if (cachedRows && cachedRows.length > 0) {
					// Refresh path: merge new server data into existing rows
					// so we don't strip already-loaded tmux info.
					const merged = mergeServerData(cachedRows, rows)
					cachedRows = merged
					updatePanel(merged)
				} else {
					// First-load path: just use what we got.
					cachedRows = rows
					updatePanel(rows)
				}
			})
			cachedRows = freshRows
			updatePanel(freshRows)
		} catch {
			// Non-fatal.
		} finally {
			if (!panelDismissed && panelRef) {
				panelRef.loading = false
			}
		}
	})()

	const result = await ctx.ui.custom<SessionPickerResult | undefined>(
		(tui, _theme, _keybindings, done) => {
			const panel = createSessionsPanel(initialRows, tui, done)
			panelRef = panel
			panel.loading = true
			return panel
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
	)

	panelDismissed = true
	if (panelRef) panelRef.loading = false

	// Let the fetch finish in the background to populate the cache.
	fetchPromise.catch(() => {})

	if (!result) return

	if (result.action === "attach") {
		await runAttach({ target: result.sessionId, tmuxSession: result.tmuxSession }, ctx)
	} else if (result.action === "connect") {
		await runConnect({ target: result.sessionId }, ctx)
	} else if (result.action === "kill-tmux" && result.tmuxSession) {
		const sessionName = cachedRows?.find((r) => r.id === result.sessionId)?.name || result.sessionId.slice(0, 8)
		const confirmed = await ctx.ui.confirm("Stop session", `Stop "${result.tmuxSession}" on ${sessionName}?`)
		if (!confirmed) return
		try {
			const auth = await authenticateRemoteSession(result.sessionId, ctx.apiKey, sessionName, {
				endpoint: ctx.endpoint,
			})
			await runSshCommandWithOutput({
				remoteHost: auth.host,
				remoteUser: SANDBOX_USER,
				authToken: auth.connectToken,
				remoteCommand: `tmux kill-session -t ${result.tmuxSession}`,
				signal: ctx.signal,
			})
			info(ctx, `Stopped "${result.tmuxSession}" on ${sessionName}.`)
			// Remove from cache.
			const cached = cachedRows?.find((r) => r.id === result.sessionId)
			if (cached?.tmuxSessions) {
				cached.tmuxSessions = cached.tmuxSessions.filter((t) => t.name !== result.tmuxSession)
			}
		} catch (err) {
			warn(ctx, `Failed to stop session: ${err instanceof Error ? err.message : String(err)}`)
		}
	} else if (result.action === "rename") {
		const currentName = cachedRows?.find((r) => r.id === result.sessionId)?.name || ""
		const newName = await ctx.ui.input("Rename session", currentName || "Enter new name")
		if (!newName || newName === currentName) return
		try {
			await renameRemoteSession(ctx.apiKey, result.sessionId, newName, { endpoint: ctx.endpoint })
			info(ctx, `Session renamed to "${newName}".`)
			// Update cache.
			const cached = cachedRows?.find((r) => r.id === result.sessionId)
			if (cached) cached.name = newName
		} catch (err) {
			warn(ctx, `Failed to rename session: ${err instanceof Error ? err.message : String(err)}`)
		}
	} else if (result.action === "delete") {
		const confirmed = await ctx.ui.confirm(
			"Delete session",
			`Are you sure you want to delete session "${result.sessionId}"?`,
		)
		if (!confirmed) return
		try {
			await deleteRemoteSession(ctx.apiKey, result.sessionId, { endpoint: ctx.endpoint })
			info(ctx, `Session "${result.sessionId}" deleted.`)
			cachedRows = cachedRows?.filter((r) => r.id !== result.sessionId)
		} catch (err) {
			warn(ctx, `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}
