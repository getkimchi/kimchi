import { basename } from "node:path"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { deleteSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import type { TeleportContext } from "../types.js"
import { pickSession } from "../ui/sessions-panel.js"
import type { CombinedStatus, SessionRow } from "../ui/sessions-table.js"
import { runAttachSession } from "./attach.js"
import { info, refuse, status, warn } from "./errors.js"

export async function runSessions(_args: string, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const description = basename(ctx.cwd) || "kimchi"

	while (true) {
		status(ctx, "Loading sessions…")
		let workspaces: Workspace[]
		try {
			workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
		} catch (err) {
			status(ctx, undefined)
			refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
		}

		const rows = await collectRows(workspaces, ctx, description)
		status(ctx, undefined)

		const result = await pickSession(ctx, rows)
		if (!result) return

		if (result.action === "open") {
			await runAttachSession({ workspaceId: result.row.workspaceId, sessionName: result.row.sessionName }, ctx)
			return
		}

		const ok = await ctx.ui.confirm(
			"Delete session",
			`Delete session ${result.row.sessionName} from workspace ${result.row.workspaceName}?`,
		)
		if (!ok) continue

		try {
			const creds = await authenticateWorkspace(result.row.workspaceId, ctx.apiKey, description, {
				endpoint: ctx.endpoint,
			})
			const client = new WorkerClient(creds)
			await deleteSession(client, result.row.sessionName, ctx.signal)
			info(ctx, `Deleted ${result.row.sessionName}`)
		} catch (err) {
			warn(ctx, `Could not delete session: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

async function collectRows(workspaces: Workspace[], ctx: TeleportContext, description: string): Promise<SessionRow[]> {
	const results = await Promise.allSettled(
		workspaces.map(async (ws): Promise<SessionRow[]> => {
			const creds = await authenticateWorkspace(ws.id, ctx.apiKey, description, { endpoint: ctx.endpoint })
			const client = new WorkerClient(creds)
			const sessions = await listSessions(client, ctx.signal)
			return sessions.filter(isVisibleSession).map((s) => toRow(ws, s))
		}),
	)

	const rows: SessionRow[] = []
	results.forEach((res, idx) => {
		const ws = workspaces[idx] as Workspace
		if (res.status === "fulfilled") {
			rows.push(...res.value)
		} else {
			rows.push(unreachableRow(ws))
		}
	})

	rows.sort((a, b) => {
		const at = a.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		const bt = b.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		return bt - at
	})
	return rows
}

// Picker-visibility predicate. Both `/sessions` and `/workspaces` count and
// list only PTY sessions that haven't finished — those are the only ones the
// Enter action (runAttachSession) can do anything useful with. ACP/RPC
// sessions and completed PTYs are filtered out.
export function isVisibleSession(s: Session): boolean {
	return s.agentMode === "PTY" && !s.finishedAt
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

export function unreachableRow(ws: Workspace): SessionRow {
	return {
		workspaceId: ws.id,
		workspaceName: ws.name,
		sessionName: "",
		status: "unreachable",
		clientConnected: false,
	}
}
