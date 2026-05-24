import type { SessionManager } from "@earendil-works/pi-coding-agent"
import { readGitToken } from "../../../config.js"
import { RemoteAuthError, authenticateRemoteSession } from "../api/index.js"
import type { AuthenticateResponse } from "../api/types.js"
import { getGitRemoteHost } from "../git-credentials.js"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import { buildRemoteAgentSession } from "../proxy/builder.js"
import { createTeleportProgress } from "../ui/progress.js"
import type { AttachArgs } from "./args.js"
import { TeleportRefusal, info, refuse, status, warn } from "./errors.js"
import { resolveSessionTarget } from "./session-resolve.js"
import { propagateGitCredentialToSandbox } from "./teleport-helpers.js"
import { SANDBOX_USER, type TeleportContext } from "./types.js"

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

export async function runAttach(args: AttachArgs, ctx: TeleportContext): Promise<{ host: string }> {
	const wrapper = ctx.wrapper
	if (!wrapper.isForegroundHomeBase) {
		refuse(ctx, "Already on a remote session. Use /detach first.")
	}

	const target = args.target.trim()
	if (!target) {
		refuse(ctx, "Usage: /attach <name-or-id>")
	}

	const progress = createTeleportProgress(ctx.ui)

	try {
		progress.step("Looking up session")
		const resolved = await resolveSessionTarget(target, ctx)
		const sessionId = resolved.sessionId
		progress.complete("Session found")

		if (resolved.knownLocally) {
			try {
				wrapper.promoteFromDetached(sessionId)
			} catch {
				// already removed or never there — fine
			}
		}

		progress.step("Authenticating")
		let authResult: AuthenticateResponse
		try {
			authResult = await authenticateRemoteSession(
				sessionId,
				ctx.apiKey,
				`Remote session for ${require("node:path").basename(ctx.cwd)}`,
				{ endpoint: ctx.endpoint },
			)
		} catch (err) {
			if (err instanceof RemoteAuthError) {
				refuse(ctx, `Authentication failed for ${sessionId}: ${err.message}`)
			}
			refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Authenticated")

		// ── Git credentials propagation (once per session per CLI run) ──
		if (!wrapper.hasGitCredentialsSynced(sessionId)) {
			const gitHost = await getGitRemoteHost(ctx.cwd)
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
						wrapper.markGitCredentialsSynced(sessionId)
						progress.complete("Git credentials configured")
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err)
						warn(ctx, `Could not configure git credentials on sandbox: ${msg}`)
						progress.complete("Git credentials skipped")
					}
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
				sessionManager: (wrapper.homeBase as { sessionManager: SessionManager }).sessionManager,
				cwd: ctx.cwd,
			})
		} catch (err) {
			refuse(ctx, `Could not connect to remote session: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Connected")

		try {
			await remote.getMessages()
		} catch {
			// Non-fatal: the chat will be empty but the session is still usable.
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
