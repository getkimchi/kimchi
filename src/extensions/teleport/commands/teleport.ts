import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { readGitToken, writeGitToken } from "../../../config.js"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { Workspace, WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { getGitRemoteHost, parseHostFromRemoteUrl } from "../../../sandbox/git-credentials.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { Session } from "../../../sandbox/worker/types.js"
import { createTabsOverlay } from "../overlay/overlay-component.js"
import { generateSessionName } from "../overlay/tab-manager.js"
import { isGitRepo } from "../preflight/git.js"
import { runPreflight } from "../preflight/index.js"
import { SANDBOX_USER } from "../provisioning/constants.js"
import { cloneRepoOnSandbox } from "../provisioning/git-clone.js"
import {
	propagateGitConfigToSandbox,
	propagateGitCredentialToSandbox,
	readLocalGitConfig,
} from "../provisioning/git-propagate.js"
import { deriveSandboxDest, deriveSandboxDestFromRepoUrl } from "../provisioning/paths.js"
import { runRsync } from "../provisioning/rsync-runner.js"
import { readState, updateState } from "../state.js"
import type { TeleportContext } from "../types.js"
import { promptForGitToken } from "../ui/git-token-prompt.js"
import { createTeleportProgress } from "../ui/progress.js"
import { pickWorkspace } from "../ui/workspace-picker.js"
import { parseTeleportArgs } from "./args.js"
import { TeleportRefusal, refuse, warn } from "./errors.js"

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

	const workspaceId = await resolveWorkspaceId(ctx, args.workspace)
	const sessionName = args.name ?? generateSessionName()
	const description = basename(ctx.cwd) || "kimchi"

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

		await runGitProvisioning(args, ctx, creds, workspaceId, progress)

		const shouldRsyncWorkspace = !args.gitRepo && isGitRepo(ctx.cwd)
		if (shouldRsyncWorkspace) {
			progress.step("Syncing workspace")
			try {
				await runRsync({
					source: ctx.cwd,
					destination: deriveSandboxDest(ctx.cwd),
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
		const existingMatch = existing.find((s) => s.name === sessionName)
		const sessionCwd = args.gitRepo
			? deriveSandboxDestFromRepoUrl(args.gitRepo)
			: shouldRsyncWorkspace
				? deriveSandboxDest(ctx.cwd)
				: undefined
		if (existingMatch) {
			initialSession = existingMatch
		} else {
			try {
				initialSession = await createSession(client, sessionName, { agentMode: "PTY", cwd: sessionCwd }, ctx.signal)
			} catch (err) {
				refuse(ctx, `Could not create session: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		progress.complete(existingMatch ? "Attached to session" : "Session ready")

		progress.finish({
			id: workspaceId,
			url: `${creds.wsUrl}/session/${sessionName}/connect`,
			description,
		})

		updateState((s) => {
			s.lastWorkspaceId = workspaceId
		})
	} catch (err) {
		progress.stop()
		throw err
	}

	try {
		await ctx.ui.custom<undefined>(
			createTabsOverlay({
				creds,
				workspaceId,
				apiKey: ctx.apiKey,
				cwd: ctx.cwd,
				endpoint: ctx.endpoint,
				ui: ctx.ui,
				initialSession,
			}),
			{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
		)
	} finally {
		ctx.ui.setHeader(undefined)
	}
}

async function runGitProvisioning(
	args: ReturnType<typeof parseTeleportArgs>,
	ctx: TeleportContext,
	creds: WorkspaceCredentials,
	workspaceId: string,
	progress: ReturnType<typeof createTeleportProgress>,
): Promise<void> {
	const isGitCloneMode = !!args.gitRepo
	const gitHost = isGitCloneMode ? parseHostFromRemoteUrl(args.gitRepo!) : await getGitRemoteHost(ctx.cwd)

	let gitToken: string | undefined
	if (!args.noGitToken && gitHost) {
		gitToken = readGitToken(gitHost, ctx.configPath)
		if (!gitToken) {
			// The progress widget installs a global input lock; pause it so the
			// prompt's keystroke handler isn't shadowed.
			progress.pauseInput()
			let promptResult: Awaited<ReturnType<typeof promptForGitToken>>
			try {
				promptResult = await promptForGitToken(gitHost, ctx.ui)
			} finally {
				progress.resumeInput()
			}
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

	const alreadySynced = readState().gitCredentialsSyncedWorkspaces.includes(workspaceId)
	if (gitHost && gitToken && !alreadySynced) {
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
			updateState((s) => {
				if (!s.gitCredentialsSyncedWorkspaces.includes(workspaceId)) {
					s.gitCredentialsSyncedWorkspaces.push(workspaceId)
				}
			})
			progress.complete("Git credentials configured")
		} catch (err) {
			warn(ctx, `Could not configure git credentials on sandbox: ${err instanceof Error ? err.message : String(err)}`)
			progress.complete("Git credentials skipped")
		}
	}

	if (isGitCloneMode) {
		progress.step("Cloning repository")
		try {
			await cloneRepoOnSandbox({
				remoteHost: creds.host,
				remoteUser: SANDBOX_USER,
				authToken: creds.connectToken,
				repoUrl: args.gitRepo!,
				destination: deriveSandboxDestFromRepoUrl(args.gitRepo!),
				branch: args.branch,
				shallow: !args.noShallow,
				signal: ctx.signal,
			})
			progress.complete("Repository cloned")
		} catch (err) {
			refuse(ctx, `git clone failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

async function resolveWorkspaceId(ctx: TeleportContext, fromArgs?: string): Promise<string> {
	if (fromArgs) return fromArgs

	const cached = readState().lastWorkspaceId
	if (cached) return cached

	let workspaces: Workspace[]
	try {
		workspaces = await listWorkspaces(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Could not list workspaces: ${err instanceof Error ? err.message : String(err)}`)
	}

	if (workspaces.length === 0) return randomUUID()

	const choice = await pickWorkspace(ctx, workspaces)
	if (!choice) {
		// Esc/cancel: silent refusal so makeHandler swallows.
		throw new TeleportRefusal("cancelled")
	}
	if (choice.kind === "new") return randomUUID()
	return choice.id
}
