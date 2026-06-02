import { basename } from "node:path"
import { authenticateWorkspace, createOrUpdateWorkspace } from "../../../sandbox/cloud/auth.js"
import { verifyApiKey } from "../../../sandbox/cloud/keys.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { deleteWorkspace, listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { listSessions } from "../../../sandbox/worker/sessions.js"
import type { TeleportContext } from "../types.js"
import { pickWorkspace } from "../ui/workspaces-panel.js"
import type { WorkspaceRow } from "../ui/workspaces-table.js"
import { info, refuse, status, warn } from "./errors.js"
import { isVisibleSession } from "./sessions.js"
import { runTerminal } from "./terminal.js"

export async function runWorkspaces(_args: string, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const fallbackName = basename(ctx.cwd) || "kimchi"

	// Verify once for orgId; cache for the loop.
	let orgId: string
	try {
		orgId = await verifyApiKey(ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		refuse(ctx, `Could not verify API key: ${err instanceof Error ? err.message : String(err)}`)
	}

	while (true) {
		status(ctx, "Loading workspaces…")
		let workspaces: Workspace[]
		try {
			workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
		} catch (err) {
			status(ctx, undefined)
			refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
		}

		const rows = await collectRows(workspaces, ctx, fallbackName)
		status(ctx, undefined)

		const result = await pickWorkspace(ctx, rows, { allowDelete: true, allowRename: true })
		if (!result) return

		if (result.action === "select") {
			await runTerminal(result.row.id, ctx)
			return
		}
		if (result.action === "new") return

		if (result.action === "rename") {
			const next = (await ctx.ui.input("Rename workspace", result.row.name))?.trim()
			if (!next || next === result.row.name) continue
			try {
				await createOrUpdateWorkspace(orgId, result.row.id, ctx.apiKey, next, { endpoint: ctx.endpoint })
				info(ctx, `Renamed to ${next}`)
			} catch (err) {
				warn(ctx, `Could not rename workspace: ${err instanceof Error ? err.message : String(err)}`)
			}
			continue
		}

		// delete
		const label = result.row.name || result.row.id
		const countSuffix =
			result.row.sessionCount === "?"
				? " (session count unknown; existing sessions will be destroyed too)"
				: result.row.sessionCount > 0
					? ` and its ${result.row.sessionCount} session${result.row.sessionCount === 1 ? "" : "s"}`
					: ""
		const ok = await ctx.ui.confirm("Delete workspace", `Delete workspace ${label}${countSuffix}?`)
		if (!ok) continue

		try {
			await deleteWorkspace(orgId, result.row.id, ctx.apiKey, { endpoint: ctx.endpoint })
			info(ctx, `Deleted ${label}`)
		} catch (err) {
			warn(ctx, `Could not delete workspace: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

export async function collectRows(
	workspaces: Workspace[],
	ctx: TeleportContext,
	fallbackName: string,
): Promise<WorkspaceRow[]> {
	const results = await Promise.allSettled(
		workspaces.map(async (ws): Promise<number> => {
			const creds = await authenticateWorkspace(ws.id, ctx.apiKey, ws.name || fallbackName, {
				endpoint: ctx.endpoint,
			})
			const client = new WorkerClient(creds)
			const sessions = await listSessions(client, ctx.signal)
			return sessions.filter(isVisibleSession).length
		}),
	)

	const rows = workspaces.map((ws, idx): WorkspaceRow => {
		const res = results[idx]
		const sessionCount: number | "?" = res?.status === "fulfilled" ? res.value : "?"
		return {
			id: ws.id,
			name: ws.name,
			status: ws.status,
			createdAt: ws.createdAt,
			lastActivityAt: ws.lastActivityAt,
			host: ws.host,
			sessionCount,
		}
	})

	rows.sort((a, b) => {
		const at = a.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		const bt = b.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY
		return bt - at
	})
	return rows
}
