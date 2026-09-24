/**
 * Deterministic remote git execution for the PR-first flow.
 *
 * Runs `git -C <cwd> <args...>` on the sandbox over the sandbox-ssh
 * transport (teleport/provisioning/sandbox-ssh.ts: one ssh policy, the proxy
 * auth env, and the per-call known_hosts session). Every review-phase
 * git observation (stat/diff/status) and the consent-gated push go through
 * here.
 *
 * This module is also the ONLY code path that moves code to the remote git
 * host. It never runs on its own: post-completion invokes it strictly after
 * the user has explicitly consented in the dropdown. Two push strategies:
 *
 *  1. `pushBranchRemotely` — deterministic `git push -u origin <branch>`
 *     executed on the sandbox (the branch lives only there).
 *  2. `pushViaLocalFallback` — fetch the branch from the sandbox into the
 *     local repo under `refs/kimchi-push/<branch>` (never refs/heads, never
 *     the worktree) and push it to origin with the user's LOCAL credentials.
 *     Offered ONLY as an explicit user-facing choice after the sandbox push
 *     fails (sandbox clone tokens may be read-only or absent).
 *
 * After a consented push, `pullBranchLocally` makes the branch available in
 * the user's local repo (fetch + checkout/fast-forward) — provider-agnostic
 * git, never a silent failure: manual commands are reported on any error.
 *
 * Callers resolve a SandboxGitConnection ONCE per flow (token exchange via
 * authenticateWorkspace) and then issue as many git commands as they need.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { loadConfig } from "../../config.js"
import { authenticateWorkspace } from "../../sandbox/cloud/auth.js"
import { WorkerClient } from "../../sandbox/worker/client.js"
import { getSession } from "../../sandbox/worker/sessions.js"
import type { RemoteSessionMeta } from "../agents/manager/remote-agent-runner.js"
import { readE2eSeam } from "../e2e-seam.js"
import { SANDBOX_USER } from "../teleport/provisioning/constants.js"
import { buildProxyCommand } from "../teleport/provisioning/proxy-command.js"
import {
	buildSshArgv,
	buildSshCommandString,
	buildSshProxyEnv,
	shellQuote,
	withSshSession,
} from "../teleport/provisioning/sandbox-ssh.js"

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
	/** Hard bound on the ssh round trip; exceeds it → the child is killed and
	 *  the call rejects with a timeout error. Omit for no bound. */
	timeoutMs?: number
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
	if (readE2eSeam("KIMCHI_E2E_FAKE_SANDBOX_GIT") === "1") {
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

/** Assembles the remote command executed by ssh: `git -C '<cwd>' '<arg1>' ...`. */
export function buildSandboxGitRemoteCommand(cwd: string, gitArgs: string[]): string {
	return ["git", "-C", shellQuote(cwd), ...gitArgs.map(shellQuote)].join(" ")
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
	if (readE2eSeam("KIMCHI_E2E_FAKE_SANDBOX_GIT") === "1") {
		return Promise.resolve(fakeSandboxGitResponse(opts))
	}
	const spawner = opts._spawn ?? spawn
	return withSshSession(async ({ knownHostsFile }) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...buildSshProxyEnv({ apiKey: opts.apiKey ?? loadConfig().apiKey, authToken: opts.connection.authToken }),
		}
		const argv = buildSshArgv({
			proxyCommand: opts.proxyCommand ?? buildProxyCommand(),
			knownHostsFile,
			destination: `${opts.connection.remoteUser}@${opts.connection.host}`,
			remoteCommand: buildSandboxGitRemoteCommand(opts.connection.cwd, opts.args),
		})
		return await runSshChild({
			spawner,
			args: argv,
			env,
			signal: opts.signal,
			timeoutMs: opts.timeoutMs,
			onStdoutChunk: opts.onStdoutChunk,
		})
	})
}

interface RunSshChildInput {
	spawner: typeof spawn
	args: string[]
	env: NodeJS.ProcessEnv
	signal?: AbortSignal
	timeoutMs?: number
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
		const timer =
			input.timeoutMs !== undefined
				? setTimeout(() => {
						child.kill()
						reject(new Error(`sandbox git timed out after ${input.timeoutMs}ms (ssh round trip)`))
					}, input.timeoutMs)
				: undefined
		const settle = (done: () => void) => {
			if (timer) clearTimeout(timer)
			done()
		}
		child.on("error", (err) => settle(() => reject(err)))
		child.on("close", (code) => {
			if (code === 0) settle(() => resolve({ stdout, stderr }))
			else settle(() => reject(new SandboxGitError(code ?? -1, stderr)))
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
	opts?: { signal?: AbortSignal; apiKey?: string; proxyCommand?: string; timeoutMs?: number; _spawn?: typeof spawn },
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
	await runSandboxGit({ connection, args: ["fetch", "--no-tags", "origin"], ...opts }).catch(() => {})
	await runSandboxGit({ connection, args: ["fetch", "--no-tags", "origin", baseBranch], ...opts }).catch(() => {})

	// Candidate refs in preference order: the recorded base branch, its local
	// copy, the clone's symbolic default (covers baseBranch naming drift like
	// master/main), then EVERY remote branch — the first ref with a common
	// ancestor wins.
	const candidates = [`origin/${baseBranch}`, baseBranch, "origin/HEAD"]
	const refs = await runSandboxGit({
		connection,
		args: ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"],
		...opts,
	}).catch(() => undefined)
	if (refs) {
		for (const line of refs.stdout.split("\n")) {
			const ref = line.trim()
			if (ref && ref !== "origin/HEAD" && !candidates.includes(ref)) candidates.push(ref)
		}
	}
	for (const ref of candidates) {
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

// ---------------------------------------------------------------------------
// Push — primary (sandbox) and fallback (local machine)

export type PushFailureKind = "auth" | "non-fast-forward" | "transport" | "unknown"

export interface PushFailure {
	kind: PushFailureKind
	/** Human-readable explanation, derived from git's stderr. */
	reason: string
	/** Raw stderr tail for the notify payload. */
	stderr?: string
}

export type PushResult = { ok: true } | { ok: false; failure: PushFailure }

/** Classify a failed `git push` stderr into an actionable kind. */
export function classifyPushFailure(stderr: string): PushFailure {
	const text = stderr.toLowerCase()
	if (/non-fast-forward|fetch first|stale info/.test(text)) {
		return {
			kind: "non-fast-forward",
			reason: "The remote already has this branch with different commits — someone else pushed to it.",
			stderr,
		}
	}
	if (/permission denied|authentication failed|could not read from|403|401|repository not found/.test(text)) {
		return {
			kind: "auth",
			reason:
				"The sandbox's git credential could not push (read-only or missing). Use the local fallback to push with your own credentials.",
			stderr,
		}
	}
	if (
		/connection (refused|reset)|operation timed out|network is unreachable|name or service not known|no route to host/.test(
			text,
		)
	) {
		return { kind: "transport", reason: "Could not reach the remote git host from the sandbox (network).", stderr }
	}
	return { kind: "unknown", reason: `git push failed: ${stderr.trim().split("\n")[0] ?? "unknown error"}`, stderr }
}

/**
 * Push the branch from the sandbox: `git push -u origin <branch>` via the
 * shared SSH transport. Never force-pushes. Failures are classified — never
 * thrown — so the caller can offer the local fallback explicitly.
 */
export async function pushBranchRemotely(opts: {
	connection: SandboxGitConnection
	branch: string
	signal?: AbortSignal
	onStdoutChunk?: (chunk: string) => void
	/** Test seam: injectable runner. Defaults to this module's runSandboxGit. */
	_runSandboxGit?: typeof runSandboxGit
}): Promise<PushResult> {
	const run = opts._runSandboxGit ?? runSandboxGit
	try {
		await run({
			connection: opts.connection,
			args: ["push", "-u", "origin", opts.branch],
			signal: opts.signal,
			onStdoutChunk: opts.onStdoutChunk,
		})
		return { ok: true }
	} catch (err) {
		const stderr = (err as Partial<SandboxGitError>).stderr ?? (err instanceof Error ? err.message : String(err))
		return { ok: false, failure: classifyPushFailure(stderr) }
	}
}

/**
 * Local fallback: fetch the sandbox branch into the user's repo under
 * `refs/kimchi-push/<branch>` (never touches refs/heads or the worktree),
 * then push it to origin with the user's local credentials.
 *
 * The fetch goes through the sandbox-ssh transport (GIT_SSH_COMMAND from
 * buildSshCommandString); the push runs with the plain ambient
 * environment (the user's own git/ssh config untouched).
 */
export async function pushViaLocalFallback(opts: {
	connection: SandboxGitConnection
	branch: string
	localRepo: string
	/** Cloud API key for the ProxyCommand tunnel; defaults to loadConfig(). */
	apiKey?: string
	/** Test seams. */
	execFile?: typeof execFileSync
	proxyCommand?: string
}): Promise<PushResult> {
	const exec = opts.execFile ?? execFileSync
	const stagingRef = `refs/kimchi-push/${opts.branch}`
	return withSshSession(async ({ knownHostsFile }) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_SSH_COMMAND: buildSshCommandString({
				proxyCommand: opts.proxyCommand ?? buildProxyCommand(),
				knownHostsFile,
			}),
			...buildSshProxyEnv({ apiKey: opts.apiKey ?? loadConfig().apiKey, authToken: opts.connection.authToken }),
		}
		const sshUrl = `ssh://${opts.connection.remoteUser}@${opts.connection.host}${opts.connection.cwd}`
		try {
			exec("git", ["fetch", "--no-tags", sshUrl, `+refs/heads/${opts.branch}:${stagingRef}`], {
				cwd: opts.localRepo,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			})
			try {
				exec("git", ["push", "-u", "origin", `${stagingRef}:refs/heads/${opts.branch}`], {
					cwd: opts.localRepo,
					stdio: ["ignore", "pipe", "pipe"],
				})
			} finally {
				// The staging ref is a transport scratch space — never leave it in
				// the user's repo: stale refs can mask later pushes. Best-effort.
				try {
					exec("git", ["update-ref", "-d", stagingRef], {
						cwd: opts.localRepo,
						stdio: ["ignore", "pipe", "pipe"],
					})
				} catch {
					// already gone / never created — no user-facing consequence
				}
			}
			return { ok: true }
		} catch (err) {
			const stderr = stderrOf(err) || (err instanceof Error ? err.message : String(err))
			return { ok: false, failure: classifyPushFailure(stderr) }
		}
	})
}

function stderrOf(err: unknown): string {
	if (err && typeof err === "object" && "stderr" in err) {
		const se = (err as { stderr?: unknown }).stderr
		if (Buffer.isBuffer(se)) return se.toString("utf8")
		if (typeof se === "string") return se
	}
	return ""
}

// ---------------------------------------------------------------------------
// Local branch pull (after a consented push to origin)

export interface PullBranchSuccess {
	kind: "pulled"
	/** What happened to the local branch. */
	action: "created" | "checked-out" | "fast-forwarded"
}
export interface PullBranchFailure {
	kind: "failed"
	/** Human-readable reason (first stderr line). */
	reason: string
	/** The exact manual commands the user can run themselves. */
	command: string
}
export type PullBranchResult = PullBranchSuccess | PullBranchFailure

/**
 * After a consented push to origin, make the branch available locally:
 * fetch it from origin, then when the local branch already exists switch to
 * it and fast-forward-merge, otherwise create it tracking origin/<branch>.
 * NEVER throws, NEVER touches origin, and reports the exact manual commands
 * on any failure (dirty worktree, diverged branch).
 */
export function pullBranchLocally(opts: {
	localRepo: string
	branch: string
	execFile?: typeof execFileSync
}): PullBranchResult {
	const { localRepo, branch } = opts
	const command = `git fetch origin ${branch} && git switch ${branch} && git merge --ff-only origin/${branch}`
	const exec = opts.execFile ?? execFileSync
	const run = (args: string[]): void => {
		exec("git", args, { cwd: localRepo, stdio: ["ignore", "pipe", "pipe"] })
	}
	try {
		run(["fetch", "--no-tags", "origin", branch])
		let exists = true
		try {
			run(["rev-parse", "--verify", `refs/heads/${branch}`])
		} catch {
			exists = false
		}
		if (!exists) {
			run(["switch", "-c", branch, "--track", `origin/${branch}`])
			return { kind: "pulled", action: "created" }
		}
		run(["switch", branch])
		run(["merge", "--ff-only", `origin/${branch}`])
		return { kind: "pulled", action: "fast-forwarded" }
	} catch (err) {
		const stderr = stderrOf(err) || (err instanceof Error ? err.message : String(err))
		return { kind: "failed", reason: stderr.trim().split("\n")[0] ?? "unknown git error", command }
	}
}
