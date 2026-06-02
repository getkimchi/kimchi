import { randomUUID } from "node:crypto"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import type { TeleportContext } from "../types.js"
import { pickWorkspace } from "../ui/workspaces-panel.js"
import type { WorkspaceRow } from "../ui/workspaces-table.js"
import { TeleportRefusal, refuse } from "./errors.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
	return UUID_RE.test(s)
}

export function leftmostLabel(host: string | undefined): string | undefined {
	if (!host) return undefined
	const dot = host.indexOf(".")
	return dot === -1 ? host : host.slice(0, dot)
}

export function matchesHostNickname(host: string | undefined, ref: string): boolean {
	const label = leftmostLabel(host)?.toLowerCase()
	if (!label) return false
	const r = ref.toLowerCase()
	if (!r) return false
	return label === r || label.startsWith(`${r}-`)
}

export interface ResolveOpts {
	onEmpty: { kind: "mint" } | { kind: "refuse"; message: string }
	cancelledMessage?: string
}

export async function resolveWorkspaceRef(
	ctx: TeleportContext,
	ref: string | undefined,
	opts: ResolveOpts,
): Promise<string> {
	if (ref && isUuid(ref)) return ref

	if (ref) {
		let workspaces: Workspace[]
		try {
			workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
		} catch (err) {
			refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
		}
		const matches = workspaces.filter(
			(w) => w.name.toLowerCase() === ref.toLowerCase() || matchesHostNickname(w.host, ref),
		)
		if (matches.length === 1) return matches[0].id
		if (matches.length === 0) {
			refuse(ctx, `No workspace matching "${ref}". Try /workspaces to see the available ones.`)
		}
		const rows = matches
			.map((w) => `  • ${w.id}  ${w.name || "(no name)"}  [${leftmostLabel(w.host) ?? "no-host"}]`)
			.join("\n")
		refuse(ctx, `Workspace "${ref}" is ambiguous. Use the UUID to disambiguate:\n${rows}`)
	}

	let workspaces: Workspace[]
	try {
		workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
	}

	if (workspaces.length === 0) {
		if (opts.onEmpty.kind === "mint") return randomUUID()
		refuse(ctx, opts.onEmpty.message)
	}

	const allowNew = opts.onEmpty.kind === "mint"
	const rows: WorkspaceRow[] = workspaces.map((w) => ({
		id: w.id,
		name: w.name,
		status: w.status,
		createdAt: w.createdAt,
		lastActivityAt: w.lastActivityAt,
		host: w.host,
		sessionCount: "?",
	}))
	const choice = await pickWorkspace(ctx, rows, { allowNew, hideSessions: true })
	if (!choice) {
		throw new TeleportRefusal(opts.cancelledMessage ?? "cancelled")
	}
	if (choice.action === "new") {
		return randomUUID()
	}
	return choice.row.id
}
