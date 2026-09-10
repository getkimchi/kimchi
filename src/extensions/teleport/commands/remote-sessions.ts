import { basename, isAbsolute, join } from "node:path"
import { authenticateWorkspace, createOrUpdateWorkspace } from "../../../sandbox/cloud/auth.js"
import { verifyApiKey } from "../../../sandbox/cloud/keys.js"
import { getQuotaUsage } from "../../../sandbox/cloud/quota.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { deleteWorkspace, listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { deleteSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { isVisibleSession } from "../session-filter.js"
import { ensureIncludeDirective, syncSshConfig } from "../ssh-config/sync.js"
import type { TeleportContext } from "../types.js"
import type { RemoteSessionNode, RemoteWorkspaceNode } from "../ui/remote-sessions-panel.js"
import { pickRemoteSessions } from "../ui/remote-sessions-panel.js"
import type { CombinedStatus, SessionRow } from "../ui/sessions-table.js"
import { assignWorkspaceSlugs } from "../workspace-slugs.js"
import { runAttachSession } from "./attach.js"
import { info, refuse, status, warn } from "./errors.js"
import { runSyncArgs } from "./sync.js"
import { runTerminal } from "./terminal.js"

export async function runRemoteSessions(_args: string, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const fallbackName = basename(ctx.cwd) || "kimchi"

	// Verify once for orgId; cache for the loop (needed for rename/delete
	// workspace) — also shared with listWorkspaces/getQuotaUsage below so both
	// skip their own duplicate verifyKey round-trip.
	let orgId: string
	try {
		orgId = await verifyApiKey(ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		refuse(ctx, `Could not verify API key: ${err instanceof Error ? err.message : String(err)}`)
	}

	while (true) {
		status(ctx, "Loading…")
		// Quota footer fills in asynchronously: fire it alongside the workspace
		// list and hand the promise to the picker — its footer rows are reserved
		// either way and populate when the fetch settles. Failures degrade to
		// "no summary" (pre-caught so the picker never sees a rejection), and a
		// slow quota endpoint never delays the picker. Reuse the orgId verified
		// above to skip a duplicate verifyKey round-trip.
		const quotaPromise = getQuotaUsage(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId }).catch(
			() => undefined,
		)
		let workspaces: Workspace[]
		try {
			workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId })
		} catch (err) {
			status(ctx, undefined)
			refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
		}

		await ensureIncludeDirective(ctx)
		await syncSshConfig(workspaces, ctx)

		const nodes = await buildTree(workspaces, ctx, fallbackName)
		status(ctx, undefined)

		const result = await pickRemoteSessions(ctx, nodes, quotaPromise)
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

		if (result.action === "sync-workspace") {
			warn(
				ctx,
				`Only sessions can be synced. Select a session under workspace ${result.node.row.name || result.node.row.id} and press s.`,
			)
			continue
		}

		if (result.action === "sync-session") {
			await syncSession(result.node, ctx)
			continue
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

	const slugMap = assignWorkspaceSlugs(workspaces)

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
				displayName: slugMap.get(ws.id) ?? ws.name,
				status: ws.status,
				createdAt: ws.createdAt,
				lastActivityAt: ws.lastActivityAt,
				host: ws.host,
				sessionCount: reachable ? sessions.length : "?",
				cpuMillicores: ws.cpuMillicores,
				ramBytes: ws.ramBytes,
				pvcSizeBytes: ws.pvcSizeBytes,
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
		cwd: s.cwd || undefined,
		status: deriveStatus(s),
		clientConnected: s.clientConnected,
		lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt) : undefined,
	}
}

const SYNC_UP = "Sync Up  (local → remote)"
const SYNC_DOWN = "Sync Down  (remote → local)"

/**
 * Questionnaire behind the remote-sessions `s` hotkey: pick a direction,
 * then source and destination paths. The local field is prefilled with the
 * current working dir and the remote field with the session's remote cwd —
 * for `up` the source is local, for `down` it is remote.
 */
async function syncSession(session: RemoteSessionNode, ctx: TeleportContext): Promise<void> {
	const direction = await ctx.ui.select(
		`Sync ${session.sessionName} (${session.workspaceName || session.workspaceId})`,
		[SYNC_UP, SYNC_DOWN],
	)
	if (!direction) return

	const up = direction === SYNC_UP
	const localDefault = ctx.cwd
	const remoteDefault = session.cwd || "~/"

	const source = await ctx.ui.input(
		`Source path (${up ? "local" : "remote, on the workspace"}, default: ${up ? localDefault : remoteDefault})`,
	)
	if (source === undefined) return
	const target = await ctx.ui.input(
		`Destination path (${up ? "remote, on the workspace" : "local"}, default: ${up ? remoteDefault : localDefault})`,
	)
	if (target === undefined) return

	// Empty submits fall back to the default shown in the prompt title; relative
	// paths are resolved against the corresponding default, absolute paths
	// (and `~`-rooted ones) pass through untouched.
	const resolve = (raw: string, base: string, local: boolean): string => {
		const p = raw.trim()
		if (p === "") return base
		if (local ? isAbsolute(p) : p.startsWith("/")) return p
		if (p === "~" || p.startsWith("~/")) return p
		// Remote targets are always unix — join with a literal `/` (no
		// platform separator, no `..` normalization).
		return local ? join(base, p) : `${base.replace(/\/+$/, "")}/${p}`
	}

	await runSyncArgs(
		{
			direction: up ? "up" : "down",
			workspace: session.workspaceId,
			source: resolve(source, up ? localDefault : remoteDefault, up),
			target: resolve(target, up ? remoteDefault : localDefault, !up),
			exclude: [],
			includeIgnored: false,
			delete: false,
			dryRun: false,
		},
		ctx,
	)
}
