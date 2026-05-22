import { readGitToken } from "../../../config.js"
import { RemoteAuthError, authenticateRemoteSession } from "../api/index.js"
import { getGitRemoteHost } from "../git-credentials.js"
import { buildProxyCommand } from "../proxy/proxy-command.js"
import { runChildWithTTYHandoff as runChildWithTTYHandoffImpl } from "../ui/tty-handoff.js"
import type { ConnectArgs } from "./args.js"
import { info, refuse, status, warn } from "./errors.js"
import { readSessionId } from "./session-resolve.js"
import { resolveSessionTarget } from "./session-resolve.js"
import { propagateGitCredentialToSandbox } from "./teleport-helpers.js"
import { SANDBOX_USER, type TeleportContext } from "./types.js"

type RunChildFn = typeof runChildWithTTYHandoffImpl

export interface RunConnectInternals {
	_runChildWithTTYHandoff?: RunChildFn
}

export async function runConnect(
	args: ConnectArgs,
	ctx: TeleportContext,
	internals: RunConnectInternals = {},
): Promise<void> {
	const wrapper = ctx.wrapper
	const runChild = internals._runChildWithTTYHandoff ?? runChildWithTTYHandoffImpl

	let sessionId: string
	if (args.target) {
		const resolved = await resolveSessionTarget(args.target.trim(), ctx)
		sessionId = resolved.sessionId
	} else {
		if (wrapper.isForegroundHomeBase) {
			refuse(ctx, "Not connected to a remote session. Pass a name/id to /connect, or use /teleport or /attach first.")
		}
		const fgId = readSessionId(wrapper.foreground as unknown as import("../proxy/agent-session.js").RemoteAgentSession)
		if (!fgId) {
			refuse(ctx, "Foreground remote has no session id; cannot connect.")
		}
		sessionId = fgId
	}

	status(ctx, "Authenticating SSH…")
	let auth: import("../api/types.js").AuthenticateResponse
	try {
		auth = await authenticateRemoteSession(
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
	status(ctx, undefined)

	// ── Git credentials propagation (once per session per CLI run) ──
	if (!wrapper.hasGitCredentialsSynced(sessionId)) {
		const gitHost = await getGitRemoteHost(ctx.cwd)
		if (gitHost) {
			const gitToken = readGitToken(gitHost, ctx.configPath)
			if (gitToken) {
				try {
					await propagateGitCredentialToSandbox({
						remoteHost: auth.host,
						remoteUser: SANDBOX_USER,
						authToken: auth.connectToken,
						gitHost,
						gitToken,
						signal: ctx.signal,
					})
					wrapper.markGitCredentialsSynced(sessionId)
				} catch (err) {
					warn(
						ctx,
						`Could not configure git credentials on sandbox: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
		}
	}

	const proxyCommand = buildProxyCommand()

	const sshArgs = [
		"-o",
		`ProxyCommand=${proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"LogLevel=ERROR",
		`${SANDBOX_USER}@${auth.host}`,
	]
	const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: auth.connectToken }

	info(ctx, `Connecting to ${sessionId.slice(0, 8)}…`)
	let code = 0
	try {
		code = await runChild({ cmd: "ssh", args: sshArgs, env, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Failed to launch ssh: ${err instanceof Error ? err.message : String(err)}`)
	}
	if (code !== 0) {
		warn(ctx, `ssh exited with code ${code}.`)
	}
}
