import { randomUUID } from "node:crypto"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import type { TeleportContext } from "../types.js"
import { pickWorkspace } from "../ui/workspace-picker.js"
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
	cannotCreateMessage?: string
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

	const choice = await pickWorkspace(ctx, workspaces)
	if (!choice) {
		throw new TeleportRefusal(opts.cancelledMessage ?? "cancelled")
	}
	if (choice.kind === "new") {
		if (opts.onEmpty.kind === "mint") return randomUUID()
		if (opts.cannotCreateMessage) refuse(ctx, opts.cannotCreateMessage)
		refuse(ctx, opts.onEmpty.message)
	}
	return choice.id
}
