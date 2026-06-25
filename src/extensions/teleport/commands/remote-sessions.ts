import { basename } from "node:path"
import { authenticateWorkspace, createOrUpdateWorkspace } from "../../../sandbox/cloud/auth.js"
import { verifyApiKey } from "../../../sandbox/cloud/keys.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { deleteWorkspace, listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { deleteSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { isVisibleSession } from "../session-filter.js"
import { ensureIncludeDirective, syncSshConfig } from "../ssh-config/sync.js"
import type { TeleportContext } from "../types.js"
import { pickRemoteSessions } from "../ui/remote-sessions-panel.js"
import type { RemoteWorkspaceNode } from "../ui/remote-sessions-panel.js"
import type { CombinedStatus, SessionRow } from "../ui/sessions-table.js"
import { runAttachSession } from "./attach.js"
import { info, refuse, status, warn } from "./errors.js"
import { runTerminal } from "./terminal.js"

export async function runRemoteSessions(_args: string, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const fallbackName = basename(ctx.cwd) || "kimchi"

	// Verify once for orgId; cache for the loop (needed for rename/delete workspace).
	let orgId: string
	try {
		orgId = await verifyApiKey(ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		refuse(ctx, `Could not verify API key: ${err instanceof Error ? err.message : String(err)}`)
	}

	while (true) {
		status(ctx, "Loading…")
		let workspaces: Workspace[]
		try {
			workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
		} catch (err) {
			status(ctx, undefined)
			refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
		}

		await ensureIncludeDirective(ctx)
		await syncSshConfig(workspaces, ctx)

		const nodes = await buildTree(workspaces, ctx, fallbackName)
		status(ctx, undefined)

		const result = await pickRemoteSessions(ctx, nodes)
		if (!result) return

		if (result.action === "open-terminal") {
			await runTerminal(result.node.row.id, ctx)
			return
		}

		if (result.action === "open-session") {
			await runAttachSession(
				{
					workspaceId: result.node.workspaceId,
					sessionName: result.node.sessionName,
					workspaceName: result.node.workspaceName,
				},
				ctx,
			)
			return
		}

		if (result.action === "rename-workspace") {
			const row = result.node.row
			const next = (await ctx.ui.input("Rename workspace", row.name))?.trim()
			if (!next || next === row.name) continue
			try {
				await createOrUpdateWorkspace(orgId, row.id, ctx.apiKey, next, { endpoint: ctx.endpoint })
				info(ctx, `Renamed to ${next}`)
			} catch (err) {
				warn(ctx, `Could not rename workspace: ${err instanceof Error ? err.message : String(err)}`)
			}
			continue
		}

		if (result.action === "delete-workspace") {
			const row = result.node.row
			const label = row.name || row.id
			const countSuffix =
				row.sessionCount === "?"
					? " (session count unknown; existing sessions will be destroyed too)"
					: row.sessionCount > 0
						? ` and its ${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"}`
						: ""
			const ok = await ctx.ui.confirm("Delete workspace", `Delete workspace ${label}${countSuffix}?`)
			if (!ok) continue
			try {
				await deleteWorkspace(orgId, row.id, ctx.apiKey, { endpoint: ctx.endpoint })
				info(ctx, `Deleted ${label}`)
			} catch (err) {
				warn(ctx, `Could not delete workspace: ${err instanceof Error ? err.message : String(err)}`)
			}
			continue
		}

		// delete-session
		const session = result.node
		const ok = await ctx.ui.confirm(
			"Delete session",
			`Delete session ${session.sessionName} from workspace ${session.workspaceName}?`,
		)
		if (!ok) continue
		try {
			const creds = await authenticateWorkspace(
				session.workspaceId,
				ctx.apiKey,
				session.workspaceName || fallbackName,
				{ endpoint: ctx.endpoint },
			)
			const client = new WorkerClient(creds)
			await deleteSession(client, session.sessionName, ctx.signal)
			info(ctx, `Deleted ${session.sessionName}`)
		} catch (err) {
			warn(ctx, `Could not delete session: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

/**
 * Fetch every workspace's sessions in a single pass and assemble the tree:
 * one workspace node per workspace, with its visible sessions as children.
 */
export async function buildTree(
	workspaces: Workspace[],
	ctx: TeleportContext,
	fallbackName: string,
): Promise<RemoteWorkspaceNode[]> {
	const results = await Promise.allSettled(
		workspaces.map(async (ws): Promise<SessionRow[]> => {
			const creds = await authenticateWorkspace(ws.id, ctx.apiKey, ws.name || fallbackName, {
				endpoint: ctx.endpoint,
			})
			const client = new WorkerClient(creds)
			const sessions = await listSessions(client, ctx.signal)
			return sessions.filter(isVisibleSession).map((s) => toRow(ws, s))
		}),
	)

	const nodes = workspaces.map((ws, idx): RemoteWorkspaceNode => {
		const res = results[idx]
		const reachable = res?.status === "fulfilled"
		const sessions = reachable ? res.value : []
		sessions.sort((a, b) => {
			const at = a.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
			const bt = b.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
			return bt - at
		})
		return {
			row: {
				id: ws.id,
				name: ws.name,
				status: ws.status,
				createdAt: ws.createdAt,
				lastActivityAt: ws.lastActivityAt,
				host: ws.host,
				sessionCount: reachable ? sessions.length : "?",
			},
			sessions,
			unreachable: !reachable,
		}
	})

	nodes.sort((a, b) => {
		const at = a.row.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		const bt = b.row.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		return bt - at
	})
	return nodes
}

export function deriveStatus(s: Session): CombinedStatus {
	if (s.finishedAt) return "completed"
	if (!s.alive) return "idle"
	return s.clientConnected ? "active" : "disconnected"
}

export function toRow(ws: Workspace, s: Session): SessionRow {
	return {
		workspaceId: ws.id,
		workspaceName: ws.name,
		sessionName: s.name,
		status: deriveStatus(s),
		clientConnected: s.clientConnected,
		lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt) : undefined,
	}
}
