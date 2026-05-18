import { exec } from "node:child_process"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { promisify } from "node:util"
import type {
	AgentSession,
	AgentSessionServices,
	ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { authenticateRemoteSession, listRemoteSessions, waitForSessionReady } from "../remote/auth.js"
import { buildRemoteAgentSession } from "../remote/build-remote-session.js"
import type { RemoteAgentSession } from "../remote/remote-agent-session.js"
import { RemoteAuthError } from "../remote/types.js"
import type { AuthenticateResponse, RemoteSessionStatus, RemoteSessionSummary } from "../remote/types.js"
import type { AttachArgs, ConnectArgs, DetachArgs, TeleportArgs } from "./args.js"
import { getTeleportProxyPath } from "./proxy-path.js"
import { BASE_EXCLUDE_GLOBS, RsyncError, runRsync } from "./rsync-transport.js"
import { type SessionRow, renderSessionsTable } from "./sessions-table.js"
import type { TeleportableAgentSession } from "./teleportable-agent-session.js"
import { runChildWithTTYHandoff as runChildWithTTYHandoffImpl } from "./tty-handoff.js"

const execAsync = promisify(exec)

const STATUS_KEY = "teleport"
const SANDBOX_USER = "sandbox"
const SANDBOX_HOME = "/home/sandbox"
const FALLBACK_TARGET_NAME = "workspace"

/**
 * Pick the subdirectory inside SANDBOX_HOME that we rsync into. The
 * default is the basename of the local source cwd, so teleport from
 * `~/Work/my-app` lands files at `/home/sandbox/my-app/`. We sync
 * into a subdir rather than directly into `/home/sandbox` for two
 * reasons:
 *
 *   1. `/home/sandbox` is owned by `root:sandbox`, so rsync's
 *      `--archive`-implied `--times` fails with `Operation not
 *      permitted` on the destination dir itself (exit 23). Creating
 *      our own subdir as the `sandbox` user means we own it and
 *      `utimes()` succeeds.
 *   2. Keeps the user's home dotfiles (`.config`, `.local`, etc.)
 *      separate from project files, and prevents `--delete` from
 *      sweeping anything outside our subdir.
 *
 * NOTE: the kimchi agent's process CWD on the sandbox is still
 * `/home/sandbox` (server-baked in `kimchi-bridge`), so the user has
 * to `cd <basename>` after connecting. Aligning the agent CWD needs
 * a worker-side change.
 */
export function deriveSandboxDest(localCwd: string): string {
	const trimmed = localCwd.replace(/\/+$/, "")
	const raw = basename(trimmed)
	// `/` and NUL are the only path-illegal bytes on Unix; replace
	// defensively. Everything else (spaces, quotes, etc.) is handled
	// by `shellEscape` further down the pipeline.
	const cleaned = raw.replace(/[/\0]/g, "_")
	const name = cleaned.length > 0 && cleaned !== "." ? cleaned : FALLBACK_TARGET_NAME
	return `${SANDBOX_HOME}/${name}/`
}
const WORKSPACE_WARN_BYTES = 500 * 1024 * 1024
const WORKSPACE_REFUSE_BYTES = 5 * 1024 * 1024 * 1024
const BUSY_WAIT_MS_LOCAL = 5_000
const BUSY_WAIT_MS_REMOTE = 10_000

export interface TeleportContext {
	wrapper: TeleportableAgentSession
	services: AgentSessionServices
	apiKey: string
	endpoint?: string
	cwd: string
	ui: ExtensionUIContext
	signal?: AbortSignal
	/**
	 * Asks InteractiveMode to re-bind its session listeners to the wrapper's
	 * current foreground. Must be invoked after `wrapper.foregroundRemote` or
	 * `wrapper.detachToHomeBase`, otherwise the TUI stays bound to the old
	 * session and the editor appears frozen. Captured by run-interactive-teleport.
	 */
	triggerRebind?: () => Promise<void>
}

export class TeleportRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TeleportRefusal"
	}
}

function refuse(ctx: TeleportContext, message: string): never {
	ctx.ui.setStatus(STATUS_KEY, undefined)
	ctx.ui.notify(message, "error")
	throw new TeleportRefusal(message)
}

function warn(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "warning")
}

function info(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "info")
}

function status(ctx: TeleportContext, text: string | undefined) {
	ctx.ui.setStatus(STATUS_KEY, text)
}

/**
 * Ask InteractiveMode to rebind to the wrapper's current foreground. Call this
 * after every `wrapper.foregroundRemote` / `wrapper.detachToHomeBase` swap.
 * The rebind is non-fatal: if it throws (e.g., extension reload glitch), the
 * wrapper transition has already happened and the user can still type — we
 * just warn so the failure is visible.
 */
async function rebindAfterSwap(ctx: TeleportContext): Promise<void> {
	if (!ctx.triggerRebind) return
	try {
		await ctx.triggerRebind()
	} catch (err) {
		warn(ctx, `Session rebind failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms)
		if (signal) {
			const onAbort = () => {
				clearTimeout(t)
				reject(new Error("aborted"))
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
		}
	})
}

async function waitUntilIdle(check: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (check()) return true
		try {
			await sleep(100, signal)
		} catch {
			return check()
		}
	}
	return check()
}

function isBusy(session: AgentSession): boolean {
	if ((session as { isStreaming?: boolean }).isStreaming) return true
	if ((session as { isBashRunning?: boolean }).isBashRunning) return true
	if ((session as { hasPendingBashMessages?: boolean }).hasPendingBashMessages) return true
	return false
}

function readSessionId(session: AgentSession | RemoteAgentSession): string | undefined {
	const id = (session as unknown as { sessionId?: unknown }).sessionId
	return typeof id === "string" && id.length > 0 ? id : undefined
}

function readSessionName(session: AgentSession | RemoteAgentSession): string | undefined {
	const name = (session as unknown as { sessionName?: unknown }).sessionName
	return typeof name === "string" && name.length > 0 ? name : undefined
}

async function whichRsync(): Promise<boolean> {
	try {
		await execAsync("command -v rsync")
		return true
	} catch {
		return false
	}
}

async function estimateWorkspaceBytes(cwd: string): Promise<number> {
	try {
		const { stdout } = await execAsync(`du -sk "${cwd}"`, { maxBuffer: 1024 * 1024 })
		const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10)
		return Number.isFinite(kb) ? kb * 1024 : 0
	} catch {
		return 0
	}
}

async function gitWorkingTreeDirty(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" status --porcelain`)
		return stdout.trim().length > 0
	} catch {
		return false
	}
}

function rsyncInstallHint(): string {
	if (process.platform === "darwin") return "Install with: brew install rsync"
	if (process.platform === "linux") return "Install with your package manager (e.g. apt install rsync)"
	return "Install rsync and ensure it is on PATH"
}

function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
	if (m === 0) return n
	if (n === 0) return m
	const dp: number[] = new Array(n + 1)
	for (let j = 0; j <= n; j++) dp[j] = j
	for (let i = 1; i <= m; i++) {
		let prev = dp[0]
		dp[0] = i
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j]
			dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1
			prev = tmp
		}
	}
	return dp[n]
}

function findCloseMatches(target: string, sessions: RemoteSessionSummary[]): RemoteSessionSummary[] {
	return sessions.filter((s) => s.name && levenshtein(s.name.toLowerCase(), target.toLowerCase()) <= 2).slice(0, 3)
}

// ───────────────────────── runTeleport ─────────────────────────

export async function runTeleport(args: TeleportArgs, ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper
	const homeBase = wrapper.homeBase as AgentSession

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

	if (!(await whichRsync())) {
		refuse(ctx, `rsync is not on PATH. ${rsyncInstallHint()}`)
	}

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi setup` to authenticate.")
	}

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

	// ── 2. Auth ──
	const sessionId = randomUUID()
	status(ctx, "Authenticating…")
	let authResult: AuthenticateResponse
	try {
		authResult = await authenticateRemoteSession(sessionId, ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	// ── 2.5. Session summary ──
	// Per-teleport target directory inside the sandbox. See
	// `deriveSandboxDest` for why we sync into a subdir rather than
	// /home/sandbox directly.
	const sandboxDest = deriveSandboxDest(ctx.cwd)
	info(
		ctx,
		[
			"Created remote session:",
			`  id:     ${sessionId}`,
			`  host:   ${authResult.host}`,
			`  port:   ${authResult.port}`,
			`  url:    ${authResult.wsUrl}`,
			`  target: ${sandboxDest}`,
		].join("\n"),
	)

	// ── 3. Name uniqueness ──
	if (args.name) {
		status(ctx, "Checking name availability…")
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

	// ── 3.5. Wait for sandbox to become ACTIVE ──
	status(ctx, "Waiting for sandbox…")
	try {
		await waitForSessionReady({
			host: authResult.host,
			port: authResult.port,
			connectToken: authResult.connectToken,
			signal: ctx.signal,
			onTick: ({ elapsedMs }) => {
				status(ctx, `Waiting for sandbox… (${Math.round(elapsedMs / 1000)}s)`)
			},
		})
	} catch (err) {
		refuse(
			ctx,
			`Sandbox never became ready: ${err instanceof Error ? err.message : String(err)}\nRemote session ${sessionId} will be cleaned up automatically.`,
		)
	}

	// ── 4. rsync ──
	// Each step (mkdir, rsync) shares a heartbeat that keeps the UI alive
	// during silent intervals. The phase label switches when runRsync calls
	// onPhase so the user can tell which step is running.
	const PHASE_LABEL = {
		mkdir: "Preparing remote directory…",
		rsync: "Syncing workspace…",
	} as const
	let currentPhase: "mkdir" | "rsync" = "mkdir"
	let phaseStartedAt = Date.now()
	let lastProgressAt = phaseStartedAt
	status(ctx, PHASE_LABEL.mkdir)
	const heartbeat = setInterval(() => {
		if (Date.now() - lastProgressAt > 1500) {
			const elapsed = Math.round((Date.now() - phaseStartedAt) / 1000)
			status(ctx, `${PHASE_LABEL[currentPhase]} (${elapsed}s)`)
		}
	}, 1000)
	try {
		await runRsync({
			source: ctx.cwd,
			destination: sandboxDest,
			remoteHost: authResult.host,
			remotePort: authResult.port,
			remoteUser: SANDBOX_USER,
			authToken: authResult.connectToken,
			excludeGlobs: [...BASE_EXCLUDE_GLOBS, ...args.exclude],
			includeIgnored: args.includeIgnored,
			signal: ctx.signal,
			onPhase: (phase) => {
				currentPhase = phase
				phaseStartedAt = Date.now()
				lastProgressAt = phaseStartedAt
				status(ctx, PHASE_LABEL[phase])
			},
			onProgress: (pct) => {
				lastProgressAt = Date.now()
				status(ctx, `Syncing… ${pct}%`)
			},
		})
	} catch (err) {
		let msg: string
		if (err instanceof RsyncError) {
			// Slice the head — rsync writes its actual error first, then dumps usage
			// on syntax errors. The trailing usage dump isn't useful and can drown
			// out the diagnostic.
			const stderrHead = err.stderr?.trim().slice(0, 1500) ?? ""
			msg = stderrHead ? `${err.message}\nstderr:\n${stderrHead}` : err.message
		} else {
			msg = err instanceof Error ? err.message : String(err)
		}
		refuse(ctx, `rsync failed: ${msg}\nRemote session ${sessionId} will be cleaned up automatically.`)
	} finally {
		clearInterval(heartbeat)
	}

	// ── 5. Build the RemoteAgentSession ──
	status(ctx, "Connecting…")
	let remote: RemoteAgentSession
	try {
		remote = await buildRemoteAgentSession({
			sessionId,
			apiKey: ctx.apiKey,
			endpoint: ctx.endpoint,
			services: ctx.services,
			sessionManager: (homeBase as { sessionManager: SessionManager }).sessionManager,
			cwd: ctx.cwd,
		})
	} catch (err) {
		refuse(ctx, `Could not connect to remote session: ${err instanceof Error ? err.message : String(err)}`)
	}

	// ── 6. Optional name set ──
	if (args.name) {
		try {
			await (remote as unknown as { setSessionName: (name: string) => Promise<unknown> }).setSessionName(args.name)
		} catch (err) {
			warn(ctx, `Could not set session name: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	// ── 7. Swap ──
	wrapper.foregroundRemote(remote)
	await rebindAfterSwap(ctx)

	// ── 8. Notify ──
	status(ctx, undefined)
	info(ctx, `Teleported to remote session ${sessionId}${args.name ? ` (${args.name})` : ""}.`)
}

// ───────────────────────── runDetach ─────────────────────────

export async function runDetach(args: DetachArgs, ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper
	if (wrapper.isForegroundHomeBase) {
		refuse(ctx, "Not connected to a remote session.")
	}

	const remote = wrapper.foreground as unknown as RemoteAgentSession
	const sessionId = readSessionId(remote) ?? "<unknown>"
	const name = readSessionName(remote)

	if (isBusy(remote as unknown as AgentSession)) {
		if (!args.abandonPending) {
			refuse(ctx, "Remote session is busy. Use /detach --abandon-pending to abort and detach.")
		}
		try {
			;(remote as { abortBash?: () => void }).abortBash?.()
			;(remote as { abortRetry?: () => void }).abortRetry?.()
		} catch {
			// best effort
		}
		const becameIdle = await waitUntilIdle(
			() => !isBusy(remote as unknown as AgentSession),
			BUSY_WAIT_MS_REMOTE,
			ctx.signal,
		)
		if (!becameIdle) {
			refuse(ctx, "Remote did not become idle within 10s. Try again.")
		}
	}

	status(ctx, "Disconnecting…")
	try {
		;(remote as unknown as { dispose: () => void }).dispose()
	} catch (err) {
		warn(ctx, `WS shutdown error: ${err instanceof Error ? err.message : String(err)} (continuing)`)
	}

	wrapper.detachToHomeBase()
	await rebindAfterSwap(ctx)

	status(ctx, undefined)
	const hint = name ? `/attach ${name}` : `/attach ${sessionId.slice(0, 8)}`
	info(ctx, `Detached from session ${sessionId}. Reattach with ${hint}.`)
}

// ───────────────────────── runAttach ─────────────────────────

export async function runAttach(args: AttachArgs, ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper
	if (!wrapper.isForegroundHomeBase) {
		refuse(ctx, "Already on a remote session. Use /detach first.")
	}

	const target = args.target.trim()
	if (!target) {
		refuse(ctx, "Usage: /attach <name-or-id>")
	}

	const resolved = await resolveSessionTarget(target, ctx)
	const sessionId = resolved.sessionId

	// Discard any disposed instance in the detached map — we always build fresh.
	if (resolved.knownLocally) {
		try {
			wrapper.promoteFromDetached(sessionId)
		} catch {
			// already removed or never there — fine
		}
	}

	// 3. Auth + build fresh remote.
	status(ctx, "Authenticating…")
	try {
		await authenticateRemoteSession(sessionId, ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		if (err instanceof RemoteAuthError) {
			refuse(ctx, `Authentication failed for ${sessionId}: ${err.message}`)
		}
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	status(ctx, "Loading session state…")
	let remote: RemoteAgentSession
	try {
		remote = await buildRemoteAgentSession({
			sessionId,
			apiKey: ctx.apiKey,
			endpoint: ctx.endpoint,
			services: ctx.services,
			sessionManager: (wrapper.homeBase as { sessionManager: SessionManager }).sessionManager,
			cwd: ctx.cwd,
		})
	} catch (err) {
		refuse(ctx, `Could not connect to remote session: ${err instanceof Error ? err.message : String(err)}`)
	}

	wrapper.foregroundRemote(remote)
	await rebindAfterSwap(ctx)
	status(ctx, undefined)
	info(ctx, `Attached to remote session ${sessionId}.`)
}

async function resolveSessionTarget(
	target: string,
	ctx: TeleportContext,
): Promise<{ sessionId: string; status?: RemoteSessionStatus; knownLocally: boolean }> {
	const wrapper = ctx.wrapper
	for (const [id, remote] of wrapper.getDetached()) {
		if (id === target || readSessionName(remote) === target) {
			return { sessionId: id, knownLocally: true }
		}
	}

	status(ctx, "Looking up session…")
	let sessions: RemoteSessionSummary[]
	try {
		sessions = await listRemoteSessions(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
	} catch (err) {
		refuse(ctx, `Could not look up sessions: ${err instanceof Error ? err.message : String(err)}`)
	}
	const match = sessions.find((s) => s.id === target || s.name === target)
	if (!match) {
		const close = findCloseMatches(target, sessions)
		const hint = close.length > 0 ? ` Did you mean: ${close.map((s) => s.name).join(", ")}?` : ""
		refuse(ctx, `No remote session matching "${target}".${hint}`)
	}
	if (match.status === "completed") {
		refuse(ctx, `Session "${target}" has completed and is no longer reachable.`)
	}
	return { sessionId: match.id, status: match.status, knownLocally: false }
}

// ───────────────────────── runConnect ─────────────────────────

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
		const fgId = readSessionId(wrapper.foreground as unknown as RemoteAgentSession)
		if (!fgId) {
			refuse(ctx, "Foreground remote has no session id; cannot connect.")
		}
		sessionId = fgId
	}

	status(ctx, "Authenticating SSH…")
	let auth: AuthenticateResponse
	try {
		auth = await authenticateRemoteSession(sessionId, ctx.apiKey, { endpoint: ctx.endpoint })
	} catch (err) {
		if (err instanceof RemoteAuthError) {
			refuse(ctx, `Authentication failed for ${sessionId}: ${err.message}`)
		}
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}
	status(ctx, undefined)

	const proxyPath = getTeleportProxyPath()
	const sshArgs = [
		"-p",
		String(auth.port),
		"-o",
		`ProxyCommand=node ${proxyPath} %h %p`,
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
		ctx.ui.notify(`ssh exited with code ${code}.`, "warning")
	}
}

// ───────────────────────── runListSessions ─────────────────────────

export async function runListSessions(ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper

	let serverSessions: RemoteSessionSummary[] = []
	try {
		serverSessions = await listRemoteSessions(ctx.apiKey, { endpoint: ctx.endpoint, signal: ctx.signal })
	} catch (err) {
		warn(
			ctx,
			`Could not fetch server sessions: ${err instanceof Error ? err.message : String(err)}. Showing local state only.`,
		)
	}

	const knownIds = new Set<string>()
	const rows: SessionRow[] = []

	if (!wrapper.isForegroundHomeBase) {
		const fg = wrapper.foreground as unknown as RemoteAgentSession
		const id = readSessionId(fg)
		if (id) {
			const match = serverSessions.find((s) => s.id === id)
			rows.push({
				id,
				name: readSessionName(fg) ?? match?.name ?? "",
				state: "foreground",
				status: match?.status,
				createdAt: match?.createdAt,
				lastActivityAt: match?.lastActivityAt,
			})
			knownIds.add(id)
		}
	}

	for (const [id, remote] of wrapper.getDetached()) {
		const match = serverSessions.find((s) => s.id === id)
		rows.push({
			id,
			name: readSessionName(remote) ?? match?.name ?? "",
			state: "detached (this kimchi)",
			status: match?.status,
			createdAt: match?.createdAt,
			lastActivityAt: match?.lastActivityAt,
		})
		knownIds.add(id)
	}

	for (const s of serverSessions) {
		if (knownIds.has(s.id)) continue
		rows.push({
			id: s.id,
			name: s.name,
			state: s.hasConnectedClient ? "active elsewhere" : "detached",
			status: s.status,
			createdAt: s.createdAt,
			lastActivityAt: s.lastActivityAt,
		})
	}

	if (rows.length === 0) {
		info(ctx, "No remote sessions.")
		return
	}

	info(ctx, renderSessionsTable(rows))
}
