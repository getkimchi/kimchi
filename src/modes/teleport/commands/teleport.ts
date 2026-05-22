import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { readGitToken, writeGitToken } from "../../../config.js"
import { authenticateRemoteSession, listRemoteSessions, waitForSessionReady } from "../api/index.js"
import type { AuthenticateResponse } from "../api/types.js"
import { getGitRemoteHost, parseHostFromRemoteUrl } from "../git-credentials.js"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import { buildRemoteAgentSession } from "../proxy/builder.js"
import { BASE_EXCLUDE_GLOBS, RsyncError, runRsync } from "../sync/rsync.js"
import { exportSessionForTeleport } from "../sync/session-export.js"
import { promptForGitToken } from "../ui/git-token-prompt.js"
import { createTeleportProgress } from "../ui/progress.js"
import type { TeleportArgs } from "./args.js"
import { TeleportRefusal, info, refuse, status, warn } from "./errors.js"
import { resolveSessionTarget } from "./session-resolve.js"
import {
	cloneRepoOnSandbox,
	deriveSandboxDest,
	estimateWorkspaceBytes,
	gitWorkingTreeDirty,
	isBusy,
	propagateGitConfigToSandbox,
	propagateGitCredentialToSandbox,
	readLocalGitConfig,
	rsyncInstallHint,
	waitUntilIdle,
	whichRsync,
} from "./teleport-helpers.js"
import {
	BUSY_WAIT_MS_LOCAL,
	SANDBOX_HOME,
	SANDBOX_USER,
	type TeleportContext,
	WORKSPACE_REFUSE_BYTES,
	WORKSPACE_WARN_BYTES,
} from "./types.js"

async function rebindAfterSwap(ctx: TeleportContext): Promise<void> {
	if (!ctx.triggerRebind) return
	try {
		await ctx.triggerRebind()
	} catch (err) {
		warn(ctx, `Session rebind failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

async function refreshUIAfterSwap(ctx: TeleportContext): Promise<void> {
	if (ctx.triggerFreshUI) {
		try {
			ctx.triggerFreshUI()
		} catch (err) {
			warn(ctx, `UI refresh failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	await rebindAfterSwap(ctx)
}

/**
 * Derive a sandbox destination directory from a git remote URL.
 * Extracts the repository name from the URL path, stripping `.git` suffix.
 * Falls back to "workspace" if the name cannot be determined.
 */
export function deriveSandboxDestFromRepoUrl(repoUrl: string): string {
	// Try SSH shorthand: git@github.com:org/repo.git
	const sshMatch = repoUrl.match(/:([^/]+\/)?([^/]+?)(?:\.git)?$/)
	if (sshMatch?.[2]) return `${SANDBOX_HOME}/${sshMatch[2]}/`

	// Try URL-style
	try {
		const parsed = new URL(repoUrl)
		const segments = parsed.pathname.split("/").filter(Boolean)
		const last = segments.at(-1)
		if (last) {
			const name = last.replace(/\.git$/, "")
			if (name) return `${SANDBOX_HOME}/${name}/`
		}
	} catch {
		// not a valid URL
	}

	// Last resort: use basename heuristic
	const raw = basename(repoUrl.replace(/\.git$/, "").replace(/\/+$/, ""))
	return raw ? `${SANDBOX_HOME}/${raw}/` : `${SANDBOX_HOME}/workspace/`
}

export async function runTeleport(args: TeleportArgs, ctx: TeleportContext): Promise<{ host: string }> {
	const wrapper = ctx.wrapper
	const homeBase = wrapper.homeBase as AgentSession
	const isGitCloneMode = !!args.gitRepo
	const gitRepoUrl = args.gitRepo ?? ""

	// ── 1. Pre-flight ──
	if (!wrapper.isForegroundHomeBase) {
		refuse(ctx, "Already on a remote session. Use /detach first.")
	}

	if (isBusy(homeBase) || (homeBase as { pendingMessageCount?: number }).pendingMessageCount) {
		if (!args.abandonPending) {
			refuse(ctx, "Session is busy. Use /teleport --abandon-pending to abort and proceed.")
		}
		try {
			;(homeBase as { abortBash?: () => void }).abortBash?.()
			;(homeBase as { abortRetry?: () => void }).abortRetry?.()
		} catch {
			// best effort
		}
		const becameIdle = await waitUntilIdle(() => !isBusy(homeBase), BUSY_WAIT_MS_LOCAL, ctx.signal)
		if (!becameIdle) {
			refuse(ctx, "Could not bring the local session to an idle state in time. Try again.")
		}
	}

	// rsync pre-flight only applies in workspace-sync mode
	if (!isGitCloneMode) {
		if (!(await whichRsync())) {
			refuse(ctx, `rsync is not on PATH. ${rsyncInstallHint()}`)
		}
	}

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi setup` to authenticate.")
	}

	// Dirty tree / workspace size checks only apply in workspace-sync mode
	if (!isGitCloneMode) {
		if (!args.allowDirty && (await gitWorkingTreeDirty(ctx.cwd))) {
			refuse(ctx, "Working tree has uncommitted changes. Re-run with --allow-dirty to ship them.")
		}

		const wsBytes = await estimateWorkspaceBytes(ctx.cwd)
		if (wsBytes > WORKSPACE_REFUSE_BYTES && !args.force) {
			const gb = (wsBytes / 1024 / 1024 / 1024).toFixed(1)
			refuse(ctx, `Workspace is large (${gb} GB). Re-run with --force to proceed.`)
		}
		if (wsBytes > WORKSPACE_WARN_BYTES) {
			const mb = (wsBytes / 1024 / 1024).toFixed(0)
			warn(ctx, `Workspace is ${mb} MB — sync may take a while.`)
		}
	}

	// ── 2. Git credentials resolution ──
	let gitToken: string | undefined
	// In git-clone mode, derive the host from the provided repo URL.
	// In rsync mode, detect from the local git remote.
	const gitHost = isGitCloneMode ? parseHostFromRemoteUrl(gitRepoUrl) : await getGitRemoteHost(ctx.cwd)
	if (!args.noGitToken) {
		if (gitHost) {
			// Check if we already have a stored token for this host
			gitToken = readGitToken(gitHost, ctx.configPath)
			if (gitToken) {
				info(ctx, `Using saved git token for ${gitHost}`)
			} else {
				// Show TUI prompt for the user to paste a token
				const promptResult = await promptForGitToken(gitHost, ctx.ui)
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
				// outcome === "skipped" → gitToken stays undefined, proceed without
			}
		}
	}

	// ── 3. Progress widget ──
	const progress = createTeleportProgress(ctx.ui)

	try {
		progress.step("Authenticating")
		const sessionId = randomUUID()
		let authResult: AuthenticateResponse
		try {
			authResult = await authenticateRemoteSession(
				sessionId,
				ctx.apiKey,
				`Remote session for ${isGitCloneMode ? gitRepoUrl : require("node:path").basename(ctx.cwd)}`,
				{ endpoint: ctx.endpoint },
			)
		} catch (err) {
			refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Authenticated")

		const sandboxDest = isGitCloneMode ? deriveSandboxDestFromRepoUrl(gitRepoUrl) : deriveSandboxDest(ctx.cwd)

		if (args.name) {
			try {
				const sessions = await listRemoteSessions(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
				if (sessions.some((s) => s.name === args.name)) {
					refuse(ctx, `A session named "${args.name}" already exists. Try /attach ${args.name}.`)
				}
			} catch (err) {
				if (err instanceof TeleportRefusal) throw err
				warn(ctx, `Could not verify name uniqueness: ${err instanceof Error ? err.message : String(err)}`)
			}
		}

		progress.step("Preparing sandbox")
		try {
			await waitForSessionReady({ wsUrl: authResult.wsUrl, connectToken: authResult.connectToken, signal: ctx.signal })
		} catch (err) {
			refuse(
				ctx,
				`Sandbox never became ready: ${err instanceof Error ? err.message : String(err)}\nRemote session ${sessionId} will be cleaned up automatically.`,
			)
		}
		progress.complete("Sandbox ready")

		// ── Git identity & credentials propagation ──
		// In git-clone mode, credentials MUST be set up before the clone so
		// private repositories can be accessed. In rsync mode, the original
		// ordering (after workspace sync) is preserved.
		const localGitConfig = await readLocalGitConfig(ctx.cwd)

		// Session export variable — used by rsync mode only, but declared here
		// so it is accessible after the if/else block for session loading.
		let sessionExport: { localDir: string; remotePath: string } | undefined

		if (isGitCloneMode) {
			// Set up identity and credentials before clone
			if (localGitConfig.name || localGitConfig.email) {
				progress.step("Setting git identity")
				try {
					await propagateGitConfigToSandbox({
						remoteHost: authResult.host,
						remoteUser: SANDBOX_USER,
						authToken: authResult.connectToken,
						gitName: localGitConfig.name,
						gitEmail: localGitConfig.email,
						signal: ctx.signal,
					})
					progress.complete("Git identity set")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					warn(ctx, `Could not set git identity on sandbox: ${msg}`)
					progress.complete("Git identity skipped")
				}
			}
			if (gitHost && gitToken) {
				progress.step("Configuring git credentials")
				try {
					await propagateGitCredentialToSandbox({
						remoteHost: authResult.host,
						remoteUser: SANDBOX_USER,
						authToken: authResult.connectToken,
						gitHost,
						gitToken,
						signal: ctx.signal,
					})
					wrapper.markGitCredentialsSynced(sessionId)
					progress.complete("Git credentials configured")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					warn(ctx, `Could not configure git credentials on sandbox: ${msg}`)
					progress.complete("Git credentials skipped")
				}
			}

			// ── Clone repository ──
			progress.step("Cloning repository")
			try {
				await cloneRepoOnSandbox({
					remoteHost: authResult.host,
					remoteUser: SANDBOX_USER,
					authToken: authResult.connectToken,
					repoUrl: gitRepoUrl,
					destination: sandboxDest,
					branch: args.gitBranch,
					shallow: !args.noShallow,
					signal: ctx.signal,
				})
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				refuse(ctx, `git clone failed: ${msg}\nRemote session ${sessionId} will be cleaned up automatically.`)
			}
			progress.complete("Repository cloned")
		} else {
			// ── Rsync mode (original flow) ──
			if (!args.skipSession) {
				progress.step("Exporting session")
				try {
					sessionExport = exportSessionForTeleport({ homeBase, localCwd: ctx.cwd, sandboxDest })
				} catch (err) {
					warn(
						ctx,
						`Session export failed: ${err instanceof Error ? err.message : String(err)}. Continuing without session.`,
					)
				}
				progress.complete(sessionExport ? "Session exported" : "Session export skipped")
			}

			progress.step("Syncing workspace")
			try {
				await runRsync({
					source: ctx.cwd,
					destination: sandboxDest,
					remoteHost: authResult.host,
					remoteUser: SANDBOX_USER,
					authToken: authResult.connectToken,
					excludeGlobs: [...BASE_EXCLUDE_GLOBS, ...args.exclude],
					includeIgnored: args.includeIgnored,
					signal: ctx.signal,
				})
			} catch (err) {
				let msg: string
				if (err instanceof RsyncError) {
					const stderrHead = err.stderr?.trim().slice(0, 1500) ?? ""
					msg = stderrHead ? `${err.message}\nstderr:\n${stderrHead}` : err.message
				} else {
					msg = err instanceof Error ? err.message : String(err)
				}
				refuse(ctx, `rsync failed: ${msg}\nRemote session ${sessionId} will be cleaned up automatically.`)
			}
			progress.complete("Workspace synced")

			if (!args.skipSession && sessionExport) {
				progress.step("Syncing session")
				try {
					await runRsync({
						source: sessionExport.localDir,
						destination: dirname(sessionExport.remotePath),
						remoteHost: authResult.host,
						remoteUser: SANDBOX_USER,
						authToken: authResult.connectToken,
						signal: ctx.signal,
						deleteExtraneous: false,
					})
					progress.complete("Session synced")
				} catch (err) {
					warn(
						ctx,
						`Session sync failed: ${err instanceof Error ? err.message : String(err)}. Continuing without session.`,
					)
					progress.complete("Session sync skipped")
					sessionExport = undefined
				}
			}

			// Git identity & credentials (rsync mode — after workspace sync)
			if (localGitConfig.name || localGitConfig.email) {
				progress.step("Setting git identity")
				try {
					await propagateGitConfigToSandbox({
						remoteHost: authResult.host,
						remoteUser: SANDBOX_USER,
						authToken: authResult.connectToken,
						gitName: localGitConfig.name,
						gitEmail: localGitConfig.email,
						signal: ctx.signal,
					})
					progress.complete("Git identity set")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					warn(ctx, `Could not set git identity on sandbox: ${msg}`)
					progress.complete("Git identity skipped")
				}
			}
			if (gitHost && gitToken) {
				progress.step("Configuring git credentials")
				try {
					await propagateGitCredentialToSandbox({
						remoteHost: authResult.host,
						remoteUser: SANDBOX_USER,
						authToken: authResult.connectToken,
						gitHost,
						gitToken,
						signal: ctx.signal,
					})
					wrapper.markGitCredentialsSynced(sessionId)
					progress.complete("Git credentials configured")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					warn(ctx, `Could not configure git credentials on sandbox: ${msg}`)
					progress.complete("Git credentials skipped")
				}
			}
		}

		progress.step("Connecting")
		let remote: RemoteAgentSession
		try {
			remote = await buildRemoteAgentSession({
				sessionId,
				apiKey: ctx.apiKey,
				description: authResult.description,
				endpoint: ctx.endpoint,
				services: ctx.services,
				sessionManager: (homeBase as { sessionManager: SessionManager }).sessionManager,
				cwd: ctx.cwd,
			})
		} catch (err) {
			refuse(ctx, `Could not connect to remote session: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Connected")

		if (args.name) {
			try {
				await (remote as unknown as { setSessionName: (name: string) => Promise<unknown> }).setSessionName(args.name)
			} catch (err) {
				warn(ctx, `Could not set session name: ${err instanceof Error ? err.message : String(err)}`)
			}
		}

		if (!isGitCloneMode && !args.skipSession && sessionExport) {
			progress.step("Loading session")
			try {
				await remote.switchSession(sessionExport.remotePath)
				await remote.getMessages()
				await remote.getState()
				progress.complete("Session loaded")
			} catch (err) {
				warn(ctx, `Could not load session on remote: ${err instanceof Error ? err.message : String(err)}`)
				progress.complete("Session load failed")
			}
		}

		wrapper.foregroundRemote(remote)
		ctx.onHostResolved?.(authResult.host)
		await refreshUIAfterSwap(ctx)

		progress.finish({ id: sessionId, url: authResult.wsUrl, description: authResult.description })
		return { host: authResult.host }
	} finally {
		progress.stop()
		status(ctx, undefined)
	}
}
