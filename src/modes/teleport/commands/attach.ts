import { readGitToken } from "../../../config.js"
import { RemoteAuthError, authenticateRemoteSession } from "../api/index.js"
import { getGitRemoteHost } from "../git-credentials.js"
import { buildProxyCommand } from "../proxy/proxy-command.js"
import { runChildWithTTYHandoff as runChildWithTTYHandoffImpl } from "../ui/tty-handoff.js"
import type { AttachArgs } from "./args.js"
import { info, refuse, status, warn } from "./errors.js"
import { resolveSessionTarget } from "./session-resolve.js"
import { propagateGitCredentialToSandbox } from "./teleport-helpers.js"
import { SANDBOX_HOME, SANDBOX_USER, type TeleportContext } from "./types.js"

const SANDBOX_KIMCHI_BIN = `${SANDBOX_HOME}/.local/bin/kimchi`

type RunChildFn = typeof runChildWithTTYHandoffImpl

export interface RunAttachInternals {
	_runChildWithTTYHandoff?: RunChildFn
}

export async function runAttach(
	args: AttachArgs,
	ctx: TeleportContext,
	internals: RunAttachInternals = {},
): Promise<void> {
	const runChild = internals._runChildWithTTYHandoff ?? runChildWithTTYHandoffImpl

	const target = args.target.trim()
	if (!target) {
		refuse(ctx, "Usage: /attach <name-or-id>")
	}

	status(ctx, "Looking up session…")
	const resolved = await resolveSessionTarget(target, ctx)
	const sessionId = resolved.sessionId
	status(ctx, undefined)

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
	if (!ctx.gitCredentialsSynced.has(sessionId)) {
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
					ctx.gitCredentialsSynced.add(sessionId)
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
		"-t", // force TTY allocation — required for tmux
		"-o",
		`ProxyCommand=${proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"LogLevel=ERROR",
		`${SANDBOX_USER}@${auth.host}`,
		"tmux",
		"new",
		"-A",
		"-s",
		args.tmuxSession ?? "main",
		SANDBOX_KIMCHI_BIN,
	]
	const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: auth.connectToken }

	ctx.lastSessionId = sessionId
	info(ctx, `Attaching to ${sessionId.slice(0, 8)}…`)
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
