import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { resolveSshConfigPaths } from "../ssh-config/paths.js"
import { ensureIncludeDirective, syncSshConfig } from "../ssh-config/sync.js"
import type { TeleportContext } from "../types.js"
import { info, refuse, status } from "./errors.js"

export async function runSshConfig(_args: string, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	status(ctx, "Refreshing ssh_config…")
	try {
		const workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
		await ensureIncludeDirective(ctx)
		await syncSshConfig(workspaces, ctx)
		const paths = resolveSshConfigPaths()
		const provisioned = workspaces.filter((w) => typeof w.host === "string" && w.host.length > 0).length
		info(ctx, `Wrote ${provisioned} host entr${provisioned === 1 ? "y" : "ies"} to ${paths.managedFile}`)
	} catch (err) {
		refuse(ctx, `Could not refresh ssh_config: ${err instanceof Error ? err.message : String(err)}`)
	} finally {
		status(ctx, undefined)
	}
}
