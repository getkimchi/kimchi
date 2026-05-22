import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import { readGitToken, writeGitToken } from "../../../config.js"
import { authenticateRemoteSession, listRemoteSessions, waitForSessionReady } from "../api/index.js"
import type { AuthenticateResponse } from "../api/types.js"
import { getGitRemoteHost, parseHostFromRemoteUrl } from "../git-credentials.js"
import { buildProxyCommand } from "../proxy/proxy-command.js"
import { BASE_EXCLUDE_GLOBS, RsyncError, runRsync } from "../sync/rsync.js"
import { exportSessionForTeleport } from "../sync/session-export.js"
import { promptForGitToken } from "../ui/git-token-prompt.js"
import { createTeleportProgress } from "../ui/progress.js"
import { runChildWithTTYHandoff as runChildWithTTYHandoffImpl } from "../ui/tty-handoff.js"
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

const SANDBOX_KIMCHI_BIN = `${SANDBOX_HOME}/.local/bin/kimchi`

type RunChildFn = typeof runChildWithTTYHandoffImpl

export interface RunTeleportInternals {
	_runChildWithTTYHandoff?: RunChildFn
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

export async function runTeleport(
	args: TeleportArgs,
	ctx: TeleportContext,
	internals: RunTeleportInternals = {},
): Promise<void> {
	// ── Existing-session shortcut ──
	// When a name is given, check if it matches an existing session.
	// If so, skip sandbox creation and reuse the existing one.
	if (args.name) {
		try {
			const resolved = await resolveSessionTarget(args.name, ctx)
			// Session exists — delegate to the existing-session flow.
			return await runTeleportToExisting(resolved.sessionId, args, ctx, internals)
		} catch {
			// Not found — fall through to create a new sandbox with this name.
		}
	}

	return await runTeleportNew(args, ctx, internals)
}

/**
 * Teleport to an existing sandbox: authenticate, rsync/clone workspace,
 * then SSH+tmux into it.
 */
async function runTeleportToExisting(
	sessionId: string,
	args: TeleportArgs,
	ctx: TeleportContext,
	internals: RunTeleportInternals,
): Promise<void> {
	const homeBase = ctx.session
	const isGitCloneMode = !!args.gitRepo
	const gitRepoUrl = args.gitRepo ?? ""
	const tmuxSession = args.tmuxSession ?? "main"

	const progress = createTeleportProgress(ctx.ui)
	try {
		progress.step("Authenticating")
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

		// ── Git credentials ──
		if (!ctx.gitCredentialsSynced.has(sessionId)) {
			const gitHost = isGitCloneMode ? parseHostFromRemoteUrl(gitRepoUrl) : await getGitRemoteHost(ctx.cwd)
			if (gitHost) {
				const gitToken = readGitToken(gitHost, ctx.configPath)
				if (gitToken) {
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
						ctx.gitCredentialsSynced.add(sessionId)
						progress.complete("Git credentials configured")
					} catch (err) {
						warn(ctx, `Could not configure git credentials: ${err instanceof Error ? err.message : String(err)}`)
						progress.complete("Git credentials skipped")
					}
				}
			}
		}

		// ── Workspace sync ──
		let sessionExport: { localDir: string; remotePath: string } | undefined

		if (isGitCloneMode) {
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
				progress.complete("Repository cloned")
			} catch (err) {
				refuse(ctx, `git clone failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		} else {
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
				progress.complete("Workspace synced")
			} catch (err) {
				let msg: string
				if (err instanceof RsyncError) {
					const stderrHead = err.stderr?.trim().slice(0, 1500) ?? ""
					msg = stderrHead ? `${err.message}\nstderr:\n${stderrHead}` : err.message
				} else {
					msg = err instanceof Error ? err.message : String(err)
				}
				refuse(ctx, `rsync failed: ${msg}`)
			}

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
		}

		progress.finish({ id: sessionId, url: authResult.wsUrl, description: authResult.description })

		// ── SSH + tmux handoff ──
		const runChild = internals._runChildWithTTYHandoff ?? runChildWithTTYHandoffImpl
		const proxyCommand = buildProxyCommand()
		const kimchiCmd = sessionExport ? `${SANDBOX_KIMCHI_BIN} --session ${sessionExport.remotePath}` : SANDBOX_KIMCHI_BIN

		const sshArgs = [
			"-t",
			"-o",
			`ProxyCommand=${proxyCommand}`,
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"LogLevel=ERROR",
			`${SANDBOX_USER}@${authResult.host}`,
			"tmux",
			"new",
			"-A",
			"-s",
			tmuxSession,
			kimchiCmd,
		]
		const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: authResult.connectToken }

		ctx.lastSessionId = sessionId
		info(ctx, `Attaching to ${sessionId.slice(0, 8)} (tmux: ${tmuxSession})…`)
		let code = 0
		try {
			code = await runChild({ cmd: "ssh", args: sshArgs, env, signal: ctx.signal })
		} catch (err) {
			refuse(ctx, `Failed to launch ssh: ${err instanceof Error ? err.message : String(err)}`)
		}
		if (code !== 0) {
			warn(ctx, `ssh exited with code ${code}.`)
		}
	} finally {
		progress.stop()
		status(ctx, undefined)
	}
}

/**
 * Teleport to a brand-new sandbox: create session, wait for readiness,
 * rsync/clone workspace, then SSH+tmux into it.
 */
async function runTeleportNew(
	args: TeleportArgs,
	ctx: TeleportContext,
	internals: RunTeleportInternals,
): Promise<void> {
	const homeBase = ctx.session
	const isGitCloneMode = !!args.gitRepo
	const gitRepoUrl = args.gitRepo ?? ""

	// ── 1. Pre-flight ──
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
					ctx.gitCredentialsSynced.add(sessionId)
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
					ctx.gitCredentialsSynced.add(sessionId)
					progress.complete("Git credentials configured")
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					warn(ctx, `Could not configure git credentials on sandbox: ${msg}`)
					progress.complete("Git credentials skipped")
				}
			}
		}

		progress.finish({ id: sessionId, url: authResult.wsUrl, description: authResult.description })

		// ── SSH + tmux handoff ──
		const runChild = internals._runChildWithTTYHandoff ?? runChildWithTTYHandoffImpl
		const proxyCommand = buildProxyCommand()

		// Build the kimchi command, optionally loading the synced session.
		const kimchiCmd = sessionExport ? `${SANDBOX_KIMCHI_BIN} --session ${sessionExport.remotePath}` : SANDBOX_KIMCHI_BIN

		const sshArgs = [
			"-t", // force TTY allocation — required for tmux
			"-o",
			`ProxyCommand=${proxyCommand}`,
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"LogLevel=ERROR",
			`${SANDBOX_USER}@${authResult.host}`,
			"tmux",
			"new",
			"-A",
			"-s",
			args.tmuxSession ?? "main",
			kimchiCmd,
		]
		const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: authResult.connectToken }

		ctx.lastSessionId = sessionId
		info(ctx, `Attaching to ${sessionId.slice(0, 8)} (tmux: ${args.tmuxSession ?? "main"})…`)
		let code = 0
		try {
			code = await runChild({ cmd: "ssh", args: sshArgs, env, signal: ctx.signal })
		} catch (err) {
			refuse(ctx, `Failed to launch ssh: ${err instanceof Error ? err.message : String(err)}`)
		}
		if (code !== 0) {
			warn(ctx, `ssh exited with code ${code}.`)
		}
	} finally {
		progress.stop()
		status(ctx, undefined)
	}
}
