import { basename } from "node:path"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { createTabsOverlay } from "../overlay/overlay-component.js"
import type { TeleportContext } from "../types.js"
import { createTeleportProgress } from "../ui/progress.js"
import { refuse } from "./errors.js"

export interface AttachArgs {
	workspaceId: string
	sessionName: string
	/** The workspace's current server-stored name. Passed through to
	 *  authenticateWorkspace so we don't clobber it on the auth PUT. */
	workspaceName?: string
}

export async function runAttachSession(args: AttachArgs, ctx: TeleportContext): Promise<void> {
	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const { workspaceId, sessionName } = args
	const description = args.workspaceName ?? (basename(ctx.cwd) || "kimchi")

	const progress = createTeleportProgress(ctx.ui)
	let creds: WorkspaceCredentials
	let session: Session
	try {
		progress.step("Authenticating")
		try {
			creds = await authenticateWorkspace(workspaceId, ctx.apiKey, description, { endpoint: ctx.endpoint })
		} catch (err) {
			refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Authenticated")

		progress.step("Preparing sandbox")
		try {
			await waitForWorkspaceReady({
				wsUrl: creds.wsUrl,
				connectToken: creds.connectToken,
				signal: ctx.signal,
			})
		} catch (err) {
			refuse(ctx, `Sandbox never became ready: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Sandbox ready")

		progress.step("Opening session")
		const client = new WorkerClient(creds)
		let existing: Awaited<ReturnType<typeof listSessions>>
		try {
			existing = await listSessions(client, ctx.signal)
		} catch (err) {
			refuse(ctx, `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`)
		}
		const match = existing.find((s) => s.name === sessionName)
		if (!match) {
			refuse(ctx, `Session "${sessionName}" no longer exists in workspace ${workspaceId}.`)
		}
		session = match
		progress.complete("Attached to session")

		progress.finish({
			id: workspaceId,
			url: `${creds.wsUrl}/session/${sessionName}/connect`,
			description,
		})
	} catch (err) {
		progress.stop()
		throw err
	}

	await ctx.ui.custom<undefined>(
		createTabsOverlay({
			creds,
			workspaceId,
			workspaceName: description,
			apiKey: ctx.apiKey,
			cwd: ctx.cwd,
			endpoint: ctx.endpoint,
			ui: ctx.ui,
			initialSession: session,
		}),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
	)
}
