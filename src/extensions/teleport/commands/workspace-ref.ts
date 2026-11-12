import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { verifyApiKey } from "../../../sandbox/cloud/keys.js"
import { getQuotaUsage } from "../../../sandbox/cloud/quota.js"
import type { Workspace, WorkspaceSpecConfig, WorkspaceTemplateSummary } from "../../../sandbox/cloud/types.js"
import type { WorkspaceFileConfig } from "../../../sandbox/cloud/workspace-file.js"
import { loadWorkspaceFile, WorkspaceFileError } from "../../../sandbox/cloud/workspace-file.js"
import { listWorkspaceTemplates } from "../../../sandbox/cloud/workspace-templates.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import type { TeleportContext } from "../types.js"
import { openWorkspaceSetup } from "../ui/workspace-setup.js"
import { pickWorkspace } from "../ui/workspaces-panel.js"
import type { WorkspaceRow } from "../ui/workspaces-table.js"
import { refuse, TeleportRefusal, warn } from "./errors.js"

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
	/**
	 * Set only when the setup dialog ran (picker "new"): the user-confirmed
	 * workspace configuration. Presence tells teleport NOT to re-read
	 * kimchi_workspace.yaml — the dialog owns the result (a cleared form means
	 * org defaults, deliberately not file defaults). `name` is the confirmed
	 * display name; undefined falls back to the cwd basename downstream.
	 * Exactly one of `spec` (manual configuration) / `templateName` (org
	 * template, expanded server-side at creation) is set — the wire rejects
	 * both.
	 */
	setup?: {
		name?: string
		spec?: WorkspaceSpecConfig
		templateName?: string
	}
}

export async function resolveWorkspaceRef(
	ctx: TeleportContext,
	ref: string | undefined,
	opts: ResolveOpts,
): Promise<ResolvedWorkspace> {
	// Verify once up front; the ids are shared with the workspace list and the
	// quota fetch below (both skip their own verifyKey round-trip when given them).
	let orgId: string
	let userId: string | undefined
	try {
		const verified = await verifyApiKey(ctx.apiKey, { endpoint: ctx.endpoint })
		orgId = verified.organizationId
		userId = verified.userId
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
		workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId, userId })
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
		return mintViaSetupDialog(ctx, orgId, opts)
	}
	const picked = workspaces.find((w) => w.id === choice.row.id)
	return { id: choice.row.id, name: picked?.name, isNew: false }
}

/**
 * Picker "new" → interactive workspace setup dialog. The dialog prefills
 * from kimchi_workspace.yaml (a broken file refuses here, same UX as the
 * file-based mint path) and offers the organization's workspace templates as
 * ready-made configurations. Its confirmed result — display name plus either
 * a validated spec (manual) or the selected template name (server expands it
 * at creation) — rides the resolved workspace as `setup`.
 */
async function mintViaSetupDialog(ctx: TeleportContext, orgId: string, opts: ResolveOpts): Promise<ResolvedWorkspace> {
	let file: WorkspaceFileConfig | undefined
	try {
		file = loadWorkspaceFile(ctx.cwd)
	} catch (err) {
		if (err instanceof WorkspaceFileError) refuse(ctx, err.message)
		throw err
	}
	// Template catalog for the dialog's source list — best-effort: a failed
	// listing degrades to manual configuration (the dialog then opens straight
	// on the form) instead of blocking workspace creation.
	let templates: WorkspaceTemplateSummary[] = []
	try {
		templates = await listWorkspaceTemplates(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal, orgId })
	} catch (err) {
		if (!ctx.signal?.aborted) {
			warn(
				ctx,
				`Could not load workspace templates — configure manually. (${err instanceof Error ? err.message : String(err)})`,
			)
		}
	}
	const setupResult = await openWorkspaceSetup(ctx, { name: basename(ctx.cwd) || "kimchi", file }, templates)
	if (!setupResult || setupResult.action === "cancel") {
		throw new TeleportRefusal(opts.cancelledMessage ?? "cancelled")
	}
	const setup: NonNullable<ResolvedWorkspace["setup"]> = { name: setupResult.name }
	if (setupResult.templateName) {
		setup.templateName = setupResult.templateName
	} else {
		setup.spec = setupResult.spec
	}
	return { id: randomUUID(), isNew: true, setup }
}
