/**
 * Deterministic remote git execution for the PR-first flow.
 *
 * Runs `git -C <cwd> <args...>` on the sandbox over the same SSH-over-WS-proxy
 * transport the teleport rsync runner already uses (buildProxyCommand +
 * StrictHostKeyChecking=accept-new + per-call known_hosts). Every review-phase
 * git observation (stat/diff/status) and the consent-gated push go through
 * here — the user's local repo is never touched.
 *
 * Callers resolve a SandboxGitConnection ONCE per flow (token exchange via
 * authenticateWorkspace) and then issue as many git commands as they need.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../config.js"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import { WorkerClient } from "../../sandbox/worker/client.js"
import { getSession } from "../../sandbox/worker/sessions.js"
import type { RemoteSessionMeta } from "../agents/manager/remote-agent-runner.js"
import { SANDBOX_USER } from "../teleport/provisioning/constants.js"
import { buildProxyCommand } from "../teleport/provisioning/proxy-command.js"

/** Connection parameters for sandbox-side git over SSH. Resolve once, reuse. */
export interface SandboxGitConnection {
	/** Hostname of the session host (expanded by ssh's %h in ProxyCommand). */
	host: string
	/** SSH user on the sandbox. */
	remoteUser: string
	/** Bearer token surfaced to teleport-proxy via the AUTH_TOKEN env var. */
	authToken: string
	/** Absolute path of the repository working directory on the sandbox. */
	cwd: string
}

export interface RunSandboxGitOptions {
	connection: SandboxGitConnection
	/** Git arguments after `git -C <cwd>`. */
	args: string[]
	/** Cancellation. Kills the ssh child when it fires. */
	signal?: AbortSignal
	/** Fired with each stdout chunk as it arrives (streaming diff viewer). */
	onStdoutChunk?: (chunk: string) => void
	/**
	 * Cloud API key injected as KIMCHI_API_KEY for the ProxyCommand helper.
	 * Defaults to loadConfig().apiKey at call time.
	 */
	apiKey?: string
	/** Override path to the vendored teleport-proxy.js. Tests inject a stub. */
	proxyCommand?: string
	/** Test seam: injectable spawner. Defaults to child_process.spawn. */
	_spawn?: typeof spawn
}

export interface SandboxGitResult {
	stdout: string
	stderr: string
}

export class SandboxGitError extends Error {
	constructor(
		readonly exitCode: number,
		readonly stderr: string,
		message?: string,
	) {
		// Attach the first non-empty stderr line — ssh/git layer failures
		// (255 = ssh connect/auth failure) are unfixable without it.
		const firstLine = stderr
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean)
		super(message ?? `git exited with code ${exitCode}${firstLine ? `: ${firstLine}` : ""}`)
		this.name = "SandboxGitError"
	}
}

/**
 * Resolves a reusable connection from remote session metadata. Performs the
 * credential exchange (authenticateWorkspace) once; every subsequent git
 * command reuses the returned token.
 */
export async function resolveSandboxGitConnection(
	remoteSession: RemoteSessionMeta,
	apiKey: string,
	opts?: { endpoint?: string; description?: string },
): Promise<SandboxGitConnection> {
	if (process.env.KIMCHI_E2E_FAKE_SANDBOX_GIT === "1") {
		// TUI-E2E seam: skip the credential exchange entirely.
		return { host: "e2e.fake", remoteUser: SANDBOX_USER, authToken: "e2e", cwd: remoteSession.cwd }
	}
	const creds = await authenticateWorkspace(remoteSession.workspaceId, apiKey, opts?.description ?? "kimchi", {
		endpoint: opts?.endpoint ?? process.env.KIMCHI_REMOTE_ENDPOINT,
	})
	// Hibernated sandbox: SSH to a sleeping pod is a bare 255 with zero
	// feedback. The ACP attach path wakes via the session endpoint; mirror
	// it here — best-effort poll until the sandbox reports alive before any
	// git ssh goes out.
	await wakeSandboxIfAsleep(creds, remoteSession.sessionName)
	// The session may have moved hosts between runs (reconnect) — the freshly
	// exchanged credential carries the live host, while the recorded cwd
	// stays valid because the workspace filesystem persists.
	return { host: creds.host, remoteUser: SANDBOX_USER, authToken: creds.connectToken, cwd: remoteSession.cwd }
}

/**
 * Best-effort hibernation wake before SSH: poll the session endpoint until
 * the sandbox reports its pod alive (or ~90s pass). NEVER throws — the git
 * layer's own retry surfaces real failures.
 */
async function wakeSandboxIfAsleep(
	creds: Awaited<ReturnType<typeof authenticateWorkspace>>,
	sessionName: string,
): Promise<void> {
	const deadline = Date.now() + 90_000
	const client = new WorkerClient(creds)
	for (;;) {
		const session = await getSession(client, sessionName).catch(() => undefined)
		if (session?.alive) return
		if (Date.now() > deadline) return
		await new Promise((resolve) => setTimeout(resolve, 3_000))
	}
}

/** POSIX single-quote for remote shell interpolation (ssh joins argv into one remote command). */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Assembles the remote command executed by ssh: `git -C '<cwd>' '<arg1>' ...`. */
export function buildSandboxGitRemoteCommand(cwd: string, gitArgs: string[]): string {
	return ["git", "-C", shellQuote(cwd), ...gitArgs.map(shellQuote)].join(" ")
}

export interface BuildSandboxGitSshArgvInput {
	host: string
	remoteUser: string
	proxyCommand: string
	knownHostsFile: string
	remoteCommand: string
}

/** Assembles the ssh argv (same option layout as rsync-runner's buildMkdirArgv, plus keepalive). */
export function buildSandboxGitSshArgv(input: BuildSandboxGitSshArgvInput): string[] {
	return [
		"-o",
		`ProxyCommand=${input.proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${input.knownHostsFile}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=15",
		`${input.remoteUser}@${input.host}`,
		input.remoteCommand,
	]
}

/**
 * TUI-E2E seam (KIMCHI_E2E_FAKE_SANDBOX_GIT=1): deterministic canned git
 * responses with NO ssh spawn and no network. Lets the TUI E2E drive the
 * real completion dropdown/push flow end to end without a fake remote
 * worker. Test-only — never set in production; the env var is read at call
 * time so a stubbed session can't leak into a real one.
 */
function fakeSandboxGitResponse(opts: RunSandboxGitOptions): SandboxGitResult {
	const args = opts.args.join(" ")
	if (args === "rev-parse HEAD") {
		// Intentionally != the e2e baseSha (aa..) so a diff always "exists".
		return { stdout: `${"b".repeat(40)}\n`, stderr: "" }
	}
	if (args === "status --porcelain") return { stdout: "", stderr: "" }
	if (args.startsWith("diff --stat")) {
		return {
			stdout: " src/a.ts | 6 ++++--\n src/b.ts | 5 +++++\n 2 files changed, 8 insertions(+), 3 deletions(-)\n",
			stderr: "",
		}
	}
	if (args.startsWith("diff --name-only")) return { stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }
	if (args.startsWith("diff --binary") || args.startsWith("diff")) {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1111111..2222222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,3 @@",
			" export const a = 1",
			"+export const b = 2",
			"-const unused = true",
			"",
		].join("\n")
		opts.onStdoutChunk?.(patch)
		return { stdout: patch, stderr: "" }
	}
	if (args.startsWith("push")) return { stdout: "", stderr: "To origin\n * [new branch]\n" }
	return { stdout: "", stderr: "" }
}

/**
 * Runs one git command on the sandbox. Rejects with SandboxGitError on
 * non-zero exit (stderr captured), or with the spawn error itself.
 */
export async function runSandboxGit(opts: RunSandboxGitOptions): Promise<SandboxGitResult> {
	if (process.env.KIMCHI_E2E_FAKE_SANDBOX_GIT === "1") {
		return Promise.resolve(fakeSandboxGitResponse(opts))
	}
	const spawner = opts._spawn ?? spawn
	const sessionDir = join(tmpdir(), `kimchi-sandbox-git-${randomUUID()}`)
	const knownHostsFile = join(sessionDir, "known_hosts")
	try {
		await mkdir(sessionDir, { recursive: true })
		await writeFile(knownHostsFile, "", "utf-8")

		const env: NodeJS.ProcessEnv = {
			...process.env,
			KIMCHI_API_KEY: opts.apiKey ?? loadConfig().apiKey,
			AUTH_TOKEN: opts.connection.authToken,
		}
		const argv = buildSandboxGitSshArgv({
			host: opts.connection.host,
			remoteUser: opts.connection.remoteUser,
			proxyCommand: opts.proxyCommand ?? buildProxyCommand(),
			knownHostsFile,
			remoteCommand: buildSandboxGitRemoteCommand(opts.connection.cwd, opts.args),
		})
		return await runSshChild({
			spawner,
			args: argv,
			env,
			signal: opts.signal,
			onStdoutChunk: opts.onStdoutChunk,
		})
	} finally {
		await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
	}
}

interface RunSshChildInput {
	spawner: typeof spawn
	args: string[]
	env: NodeJS.ProcessEnv
	signal?: AbortSignal
	onStdoutChunk?: (chunk: string) => void
}

async function runSshChild(input: RunSshChildInput): Promise<SandboxGitResult> {
	return new Promise((resolve, reject) => {
		let stdout = ""
		let stderr = ""
		let child: ChildProcess
		try {
			child = input.spawner("ssh", input.args, {
				env: input.env,
				signal: input.signal,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (err) {
			reject(err)
			return
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8")
			stdout += text
			input.onStdoutChunk?.(text)
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8")
		})
		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr })
			else reject(new SandboxGitError(code ?? -1, stderr))
		})
	})
}

/** The run baseline: HEAD at provisioning time + the user's pre-existing dirty files. */
export interface SandboxBaseline {
	baseSha: string
	dirtyFiles: string[]
}

/**
 * Captures the run baseline right after clone+sync (before the agent prompt):
 * `git rev-parse HEAD` (the SHA the diff range forks from) and the pre-existing
 * uncommitted file list (the user's synced changes — filtered out of leftover
 * warnings at completion).
 */
export async function captureBaseline(
	connection: SandboxGitConnection,
	opts?: { signal?: AbortSignal; apiKey?: string; proxyCommand?: string; _spawn?: typeof spawn },
): Promise<SandboxBaseline> {
	const rev = await runSandboxGit({ connection, args: ["rev-parse", "HEAD"], ...opts })
	const status = await runSandboxGit({ connection, args: ["status", "--porcelain"], ...opts })
	const baseSha = rev.stdout.trim()
	if (!/^[0-9a-f]{40}$/.test(baseSha)) {
		throw new SandboxGitError(-1, rev.stderr, `captureBaseline: unexpected rev-parse output: ${baseSha.slice(0, 80)}`)
	}
	return { baseSha, dirtyFiles: parsePorcelainPaths(status.stdout) }
}

/**
 * Fallback when no pre-run baseline exists (its capture failed at dispatch
 * — the attempted-flag correctly prevents a post-commit re-capture, so HEAD
 * has moved and is no longer a valid diff start): use the fork point of
 * <baseBranch>. Best-effort fetch of origin/<baseBranch> first so clone
 * tokens that never fetched defaults still get a sane merge-base; falls
 * back to the locally-known ref. Returns undefined when the fork point
 * can't be determined.
 */
export async function recoverBaseShaFromMergeBase(
	connection: SandboxGitConnection,
	baseBranch: string,
	opts?: { signal?: AbortSignal; apiKey?: string; proxyCommand?: string; _spawn?: typeof spawn },
): Promise<string | undefined> {
	// Best effort — the clone may be offline-only or the token read-only.
	await runSandboxGit({ connection, args: ["fetch", "--no-tags", "origin", baseBranch], ...opts }).catch(() => {})
	for (const ref of [`origin/${baseBranch}`, baseBranch]) {
		const res = await runSandboxGit({ connection, args: ["merge-base", ref, "HEAD"], ...opts }).catch(() => undefined)
		const sha = res?.stdout.trim() ?? ""
		if (/^[0-9a-f]{40}$/.test(sha)) return sha
	}
	return undefined
}

/**
 * Parses `git status --porcelain` into repo-relative paths. Handles rename
 * entries ("R  old -> new" — keeps the new path) and git's C-quoted paths
 * (strips the surrounding quotes; escape sequences are left as-is, which is
 * consistent on both capture and completion reads).
 */
export function parsePorcelainPaths(porcelain: string): string[] {
	const paths: string[] = []
	for (const line of porcelain.split(/\r?\n/)) {
		if (!line.trim()) continue
		let path = line.slice(3)
		const arrow = path.indexOf(" -> ")
		if (arrow !== -1) path = path.slice(arrow + 4)
		if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
			path = path.slice(1, -1)
		}
		if (path) paths.push(path)
	}
	return paths
}
