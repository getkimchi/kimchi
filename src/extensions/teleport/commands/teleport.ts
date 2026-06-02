import { existsSync } from "node:fs"
import { basename } from "node:path"
import { readGitToken, writeGitToken } from "../../../config.js"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { getGitRemoteHost, parseHostFromRemoteUrl } from "../../../sandbox/git-credentials.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { CreateSessionRequest, Session } from "../../../sandbox/worker/types.js"
import { createTabsOverlay } from "../overlay/overlay-component.js"
import { generateSessionName } from "../overlay/tab-manager.js"
import { isGitRepo } from "../preflight/git.js"
import { runPreflight } from "../preflight/index.js"
import { SANDBOX_USER } from "../provisioning/constants.js"
import {
	propagateGitConfigToSandbox,
	propagateGitCredentialToSandbox,
	readLocalGitConfig,
} from "../provisioning/git-propagate.js"
import { deriveSandboxDest, deriveSandboxDestFromRepoUrl, repoBasename } from "../provisioning/paths.js"
import { runRsync } from "../provisioning/rsync-runner.js"
import type { TeleportContext } from "../types.js"
import { createTeleportProgress } from "../ui/progress.js"
import { parseTeleportArgs } from "./args.js"
import { refuse, warn } from "./errors.js"
import { resolveWorkspaceRef } from "./workspace-ref.js"

export async function runTeleport(rawArgs: string, ctx: TeleportContext): Promise<void> {
	let args: ReturnType<typeof parseTeleportArgs>
	try {
		args = parseTeleportArgs(rawArgs)
	} catch (err) {
		refuse(ctx, err instanceof Error ? err.message : String(err))
	}

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	runPreflight(ctx, args)

	const resolved = await resolveWorkspaceRef(ctx, args.workspace, { onEmpty: { kind: "mint" } })
	const workspaceId = resolved.id
	const sessionName = args.name ?? generateSessionName()
	// For an existing workspace, preserve its stored name. For a newly minted
	// one (resolved.name === undefined) fall back to the cwd basename.
	const description = resolved.name ?? (basename(ctx.cwd) || "kimchi")

	const progress = createTeleportProgress(ctx.ui)
	let creds: WorkspaceCredentials
	let initialSession: Session
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

		const shouldRsyncWorkspace = !args.gitRepo && isGitRepo(ctx.cwd)
		await runGitProvisioning(args, ctx, creds, progress)

		if (shouldRsyncWorkspace) {
			progress.step("Syncing workspace")
			try {
				await runRsync({
					localPath: ctx.cwd,
					remotePath: deriveSandboxDest(ctx.cwd),
					isSourceDirectory: true,
					remoteHost: creds.host,
					remoteUser: SANDBOX_USER,
					authToken: creds.connectToken,
					signal: ctx.signal,
					deleteExtraneous: false,
				})
				progress.complete("Workspace synced")
			} catch (err) {
				progress.complete("Workspace sync failed")
				refuse(ctx, `Workspace sync failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		}

		progress.step("Opening session")
		const client = new WorkerClient(creds)
		let existing: Awaited<ReturnType<typeof listSessions>>
		try {
			existing = await listSessions(client, ctx.signal)
		} catch (err) {
			refuse(ctx, `Could not list sessions: ${err instanceof Error ? err.message : String(err)}`)
		}
		if (existing.some((s) => s.name === sessionName)) {
			refuse(ctx, `Session "${sessionName}" already exists in workspace ${workspaceId}. Use /sessions to attach.`)
		}
		const sessionCwd = args.gitRepo
			? deriveSandboxDestFromRepoUrl(args.gitRepo)
			: shouldRsyncWorkspace
				? deriveSandboxDest(ctx.cwd)
				: undefined
		const sessionFileToUpload =
			!args.skipSession && ctx.sessionFile && existsSync(ctx.sessionFile) ? ctx.sessionFile : undefined
		const req: CreateSessionRequest = { agentMode: "PTY", cwd: sessionCwd }
		if (args.gitRepo) {
			req.details = {
				git: {
					repo: args.gitRepo,
					branch: args.branch,
					targetDirectory: repoBasename(args.gitRepo),
				},
			}
		}
		try {
			initialSession = await createSession(client, sessionName, req, {
				sessionFile: sessionFileToUpload,
				signal: ctx.signal,
			})
		} catch (err) {
			refuse(ctx, `Could not create session: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Session ready")

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
			initialSession,
		}),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
	)
}

async function runGitProvisioning(
	args: ReturnType<typeof parseTeleportArgs>,
	ctx: TeleportContext,
	creds: WorkspaceCredentials,
	progress: ReturnType<typeof createTeleportProgress>,
): Promise<void> {
	const gitRepo = args.gitRepo
	const gitHost = gitRepo ? parseHostFromRemoteUrl(gitRepo) : await getGitRemoteHost(ctx.cwd)

	let gitToken: string | undefined
	if (!args.noGitToken && gitHost) {
		gitToken = readGitToken(gitHost, ctx.configPath)
		if (!gitToken) {
			const promptResult = await progress.promptGitToken(gitHost)
			if (promptResult.outcome === "submitted") {
				gitToken = promptResult.token
				if (promptResult.save) {
					try {
						writeGitToken(gitHost, promptResult.token, ctx.configPath)
					} catch (err) {
						warn(ctx, `Could not save git token: ${err instanceof Error ? err.message : String(err)}`)
					}
				}
			}
		}
	}

	const localGitConfig = await readLocalGitConfig(ctx.cwd)
	if (localGitConfig.name || localGitConfig.email) {
		progress.step("Setting git identity")
		try {
			await propagateGitConfigToSandbox({
				remoteHost: creds.host,
				remoteUser: SANDBOX_USER,
				authToken: creds.connectToken,
				gitName: localGitConfig.name,
				gitEmail: localGitConfig.email,
				signal: ctx.signal,
			})
			progress.complete("Git identity set")
		} catch (err) {
			warn(ctx, `Could not set git identity on sandbox: ${err instanceof Error ? err.message : String(err)}`)
			progress.complete("Git identity skipped")
		}
	}

	if (gitHost && gitToken) {
		progress.step("Configuring git credentials")
		try {
			await propagateGitCredentialToSandbox({
				remoteHost: creds.host,
				remoteUser: SANDBOX_USER,
				authToken: creds.connectToken,
				gitHost,
				gitToken,
				signal: ctx.signal,
			})
			progress.complete("Git credentials configured")
		} catch (err) {
			warn(ctx, `Could not configure git credentials on sandbox: ${err instanceof Error ? err.message : String(err)}`)
			progress.complete("Git credentials skipped")
		}
	}
}
