import { basename } from "node:path"
import { readGitToken } from "../../../config.js"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { RemoteAuthError, type WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { getGitRemoteHost } from "../../../sandbox/git-credentials.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { SANDBOX_USER } from "../provisioning/constants.js"
import { provisionGitCredential } from "../provisioning/git-provision.js"
import { buildProxyCommand } from "../provisioning/proxy-command.js"
import type { TeleportContext } from "../types.js"
import { runChildWithTTYHandoff as runChildWithTTYHandoffImpl } from "../ui/tty-handoff.js"
import { info, refuse, status, warn } from "./errors.js"
import { resolveWorkspaceRef } from "./workspace-ref.js"

type RunChildFn = typeof runChildWithTTYHandoffImpl

export interface RunTerminalInternals {
	_runChildWithTTYHandoff?: RunChildFn
}

const USAGE_HINT = "Usage: /terminal <workspace>"

export async function runTerminal(
	rawArgs: string,
	ctx: TeleportContext,
	internals: RunTerminalInternals = {},
): Promise<void> {
	const runChild = internals._runChildWithTTYHandoff ?? runChildWithTTYHandoffImpl

	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
	if (tokens.length > 1) {
		refuse(ctx, USAGE_HINT)
	}
	const rawRef = tokens[0]

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	const workspace = await resolveWorkspaceRef(ctx, rawRef, {
		onEmpty: { kind: "refuse", message: `${USAGE_HINT} — no workspaces available.` },
	})
	const workspaceId = workspace.id

	const description = workspace.name ?? (basename(ctx.cwd) || "kimchi")

	status(ctx, "Authenticating SSH…")
	let creds: WorkspaceCredentials
	try {
		creds = await authenticateWorkspace(workspaceId, ctx.apiKey, description, { endpoint: ctx.endpoint })
	} catch (err) {
		if (err instanceof RemoteAuthError) {
			refuse(ctx, `Authentication failed for ${workspaceId}: ${err.message}`)
		}
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}
	status(ctx, undefined)

	const gitHost = await getGitRemoteHost(ctx.cwd)
	if (gitHost) {
		const gitToken = readGitToken(gitHost, ctx.configPath)
		if (gitToken) {
			try {
				await provisionGitCredential(new WorkerClient(creds), { gitHost, gitToken }, ctx.signal)
			} catch (err) {
				warn(ctx, `Could not configure git credentials on sandbox: ${err instanceof Error ? err.message : String(err)}`)
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
		`${SANDBOX_USER}@${creds.host}`,
	]
	const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: creds.connectToken }

	info(ctx, `Connecting to ${workspaceId.slice(0, 8)}…`)
	let code = 0
	try {
		code = await runChild({ cmd: "ssh", args: sshArgs, env, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Failed to launch ssh: ${err instanceof Error ? err.message : String(err)}`)
	}
	// 130 (SIGINT) and 143 (SIGTERM) are the normal ways to leave an interactive
	// shell (Ctrl-C / Ctrl-D), so don't warn on them — only on genuine failures.
	if (code !== 0 && code !== 130 && code !== 143) {
		warn(ctx, `ssh exited with code ${code}.`)
	}
}
