import { randomUUID } from "node:crypto"
import { verifyApiKey } from "../../../sandbox/cloud/keys.js"
import { getQuotaUsage } from "../../../sandbox/cloud/quota.js"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import type { TeleportContext } from "../types.js"
import { pickWorkspace } from "../ui/workspaces-panel.js"
import type { WorkspaceRow } from "../ui/workspaces-table.js"
import { refuse, TeleportRefusal } from "./errors.js"

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

export interface ResolvedWorkspace {
	id: string
	/**
	 * The workspace's current display name. Undefined only for the picker's
	 * "mint a new workspace" branch — every existing-workspace path returns
	 * it. Callers should use this as the description on subsequent
	 * `authenticateWorkspace` calls so the server-stored name is preserved.
	 */
	name?: string
	/**
	 * True only when this resolution *mints* the id client-side (empty-list
	 * mint or picker "new"). A trusted explicit UUID absent from the server
	 * listing stays attach-intent: resource requests (create-time-only,
	 * immutable server-side) may ride the upsert PUT only for client-minted
	 * ids — otherwise a workspace that actually exists 400s on any value
	 * mismatch.
	 */
	isNew: boolean
}

export async function resolveWorkspaceRef(
	ctx: TeleportContext,
	ref: string | undefined,
	opts: ResolveOpts,
): Promise<ResolvedWorkspace> {
	// Verify once up front; the orgId is shared with the workspace list and the
	// quota fetch below (both skip their own verifyKey round-trip when given it).
	let orgId: string
	try {
		orgId = await verifyApiKey(ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		refuse(ctx, `Could not verify API key: ${err instanceof Error ? err.message : String(err)}`)
	}

	// Quota summary for the picker footer — fired alongside the workspace
	// list with the shared verified orgId; the picker fills its footer when
	// the fetch settles instead of blocking on it, and a failed fetch degrades
	// to no summary (pre-caught here). Only the no-ref path can open the
	// picker, so the request is skipped entirely when an explicit ref is given.
	const quotaPromise = ref
		? undefined
		: getQuotaUsage(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId }).catch(() => undefined)
	// Always list so we can return the workspace's current name to the caller —
	// the UUID shortcut is gone because callers now use `resolved.name` to
	// avoid clobbering the server-stored description on the next PUT.
	let workspaces: Workspace[]
	try {
		workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId })
	} catch (err) {
		refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
	}

	if (ref) {
		if (isUuid(ref)) {
			const match = workspaces.find((w) => w.id === ref)
			if (match) return { id: match.id, name: match.name, isNew: false }
			// UUID provided but not present in the list. Trust the user — the
			// listing may be stale or paginated. Remains attach-intent (not
			// minted client-side), so create-time-only resources never ride its
			// PUT: if the workspace exists, mismatched values would 400.
			return { id: ref, isNew: false }
		}
		const matches = workspaces.filter(
			(w) => w.name.toLowerCase() === ref.toLowerCase() || matchesHostNickname(w.host, ref),
		)
		if (matches.length === 1) return { id: matches[0].id, name: matches[0].name, isNew: false }
		if (matches.length === 0) {
			refuse(ctx, `No workspace matching "${ref}". Try /remote-sessions to see the available ones.`)
		}
		const rows = matches
			.map((w) => `  • ${w.id}  ${w.name || "(no name)"}  [${leftmostLabel(w.host) ?? "no-host"}]`)
			.join("\n")
		refuse(ctx, `Workspace "${ref}" is ambiguous. Use the UUID to disambiguate:\n${rows}`)
	}

	if (workspaces.length === 0) {
		if (opts.onEmpty.kind === "mint") return { id: randomUUID(), isNew: true }
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
		cpuMillicores: w.cpuMillicores,
		ramBytes: w.ramBytes,
		pvcSizeBytes: w.pvcSizeBytes,
	}))
	const choice = await pickWorkspace(ctx, rows, { allowNew, hideSessions: true, quota: quotaPromise })
	if (!choice) {
		throw new TeleportRefusal(opts.cancelledMessage ?? "cancelled")
	}
	if (choice.action === "new") {
		return { id: randomUUID(), isNew: true }
	}
	const picked = workspaces.find((w) => w.id === choice.row.id)
	return { id: choice.row.id, name: picked?.name, isNew: false }
}
