import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Default exclude globs applied to every teleport rsync. Caller-supplied
 * excludes and the project's gitignored entries are appended on top.
 */
export const BASE_EXCLUDE_GLOBS: readonly string[] = [
	"node_modules/",
	"dist/",
	"build/",
	".next/",
	"target/",
	"__pycache__/",
	".venv/",
	"venv/",
	".env",
	".env.*",
	".envrc",
	"*.log",
	"*.tmp",
	".DS_Store",
	".kimchi/",
]

export interface RsyncOptions {
	/** Absolute path of the source directory on the local filesystem. */
	source: string
	/** Destination directory on the remote, e.g. "/home/sandbox/". */
	destination: string
	/** Hostname of the session host (expanded by ssh's %h in ProxyCommand). */
	remoteHost: string
	/** Port the WebSocket endpoint serves on (expanded by ssh's %p). */
	remotePort: number
	/** SSH user to log in as on the sandbox. */
	remoteUser: string
	/** Bearer token surfaced to teleport-proxy via the AUTH_TOKEN env var. */
	authToken: string
	/** Caller-supplied additional excludes (appended after gitignored ones). */
	excludeGlobs?: string[]
	/** Skip the `git ls-files --others --ignored --exclude-standard` step. */
	includeIgnored?: boolean
	/** Optional progress callback. Fires for each rsync progress2 tick. */
	onProgress?: (pct: number, bytes: number) => void
	/** Cancellation. Kills the running ssh/rsync children if it fires. */
	signal?: AbortSignal
	/** Override path to the vendored teleport-proxy.js. Defaults to the one
	 *  shipped with this module. Tests inject a stub. */
	proxyPath?: string
	/** Test seam: injectable spawner. Defaults to `child_process.spawn`. */
	_spawn?: typeof spawn
}

export interface RsyncResult {
	fileCount: number
	totalBytes: number
	durationMs: number
}

export class RsyncError extends Error {
	constructor(
		readonly exitCode: number,
		readonly stderr: string,
		message?: string,
	) {
		super(message ?? `rsync exited with code ${exitCode}`)
		this.name = "RsyncError"
	}
}

const PROXY_PATH_DEFAULT = new URL("./teleport-proxy.js", import.meta.url).pathname

interface BuildSshOptionInput {
	proxyPath: string
	knownHostsFile: string
}

/**
 * Builds the SSH command string that rsync's `-e` (or stand-alone ssh) uses.
 * The ProxyCommand chains the local node proxy that bridges the WS tunnel.
 * StrictHostKeyChecking=accept-new accepts the sandbox's ephemeral host key
 * on first contact; we trust the WSS endpoint's TLS for identity.
 */
export function buildSshOption(input: BuildSshOptionInput): string {
	return [
		"ssh",
		"-o",
		`ProxyCommand=node ${shellEscape(input.proxyPath)} %h %p`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${shellEscape(input.knownHostsFile)}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=15",
	].join(" ")
}

interface BuildRsyncArgvInput {
	source: string
	destination: string
	remoteHost: string
	remoteUser: string
	remotePort: number
	proxyPath: string
	knownHostsFile: string
	excludeFile: string
	deleteExtraneous?: boolean
}

/**
 * Pure helper: assembles the rsync argv. Caller is responsible for running it.
 */
export function buildRsyncArgv(input: BuildRsyncArgvInput): string[] {
	const sshOption = buildSshOption({ proxyPath: input.proxyPath, knownHostsFile: input.knownHostsFile })
	const args: string[] = [
		"-az",
		"--info=progress2",
		"--stats",
		"--partial",
		"--port",
		String(input.remotePort),
		"--exclude-from",
		input.excludeFile,
		"-e",
		sshOption,
	]
	// `--delete` is safe in v1 because the sandbox is freshly minted before
	// every teleport; v2 will revisit when /sync (workspace refresh) lands.
	if (input.deleteExtraneous !== false) args.push("--delete")
	args.push(ensureTrailingSlash(input.source))
	args.push(`${input.remoteUser}@${input.remoteHost}:${ensureTrailingSlash(input.destination)}`)
	return args
}

interface BuildMkdirArgvInput {
	remoteHost: string
	remoteUser: string
	remotePort: number
	proxyPath: string
	knownHostsFile: string
	destination: string
}

/**
 * Pure helper: assembles the ssh argv that pre-creates the destination
 * directory on the sandbox. Must run before rsync so the target exists.
 */
export function buildMkdirArgv(input: BuildMkdirArgvInput): string[] {
	return [
		"-p",
		String(input.remotePort),
		"-o",
		`ProxyCommand=node ${shellEscape(input.proxyPath)} %h %p`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${shellEscape(input.knownHostsFile)}`,
		"-o",
		"BatchMode=yes",
		`${input.remoteUser}@${input.remoteHost}`,
		`mkdir -p ${shellEscape(input.destination)}`,
	]
}

/**
 * Concatenates the three exclude sources into a single ordered list.
 * Order matters for human auditability (e.g. tail -f the file) but rsync
 * itself treats the file as a set.
 */
export function buildExcludeList(opts: {
	extras?: readonly string[]
	gitignored?: readonly string[]
}): string[] {
	return [...BASE_EXCLUDE_GLOBS, ...(opts.gitignored ?? []), ...(opts.extras ?? [])]
}

/**
 * Run `git ls-files --others --ignored --exclude-standard` against `cwd`.
 * Returns the gitignored paths, or an empty array if the directory is not
 * a git repository (git exits non-zero) or git is not installed.
 */
export async function resolveGitIgnored(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = spawn,
): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		const child = spawner("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], {
			cwd,
			signal,
			stdio: ["ignore", "pipe", "pipe"],
		})
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8")
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8")
		})
		child.on("error", () => {
			// git missing → behave like "not a git repo"
			resolve([])
		})
		child.on("close", (code) => {
			if (code !== 0) {
				// Not a git repo, or git found nothing to enumerate. Don't surface
				// stderr — the caller's pre-flight is responsible for warning when
				// git is missing in an interactive context.
				void stderr
				resolve([])
				return
			}
			const list = stdout
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
			resolve(list)
		})
	})
}

/**
 * Run an rsync over the WS-SSH tunnel. Pre-creates the destination directory
 * via `ssh ... mkdir -p`, then runs rsync with `--info=progress2 --stats`.
 *
 * Always cleans up the per-session known_hosts directory on both success and
 * failure paths. The caller's pre-flight (clean working tree, rsync installed,
 * size warning) is out of scope here.
 */
export async function runRsync(opts: RsyncOptions): Promise<RsyncResult> {
	const startedAt = Date.now()
	const spawner = opts._spawn ?? spawn
	const proxyPath = opts.proxyPath ?? PROXY_PATH_DEFAULT
	const sessionDir = join(tmpdir(), `kimchi-teleport-${randomUUID()}`)
	const knownHostsFile = join(sessionDir, "known_hosts")
	const excludeFile = join(sessionDir, "excludes")

	try {
		await mkdir(sessionDir, { recursive: true })
		await writeFile(knownHostsFile, "", "utf-8")

		const gitignored = opts.includeIgnored ? [] : await resolveGitIgnored(opts.source, opts.signal, spawner)
		const excludeList = buildExcludeList({ extras: opts.excludeGlobs, gitignored })
		await writeFile(excludeFile, `${excludeList.join("\n")}\n`, "utf-8")

		const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: opts.authToken }

		// 1) mkdir -p destination on the sandbox.
		await runChild({
			spawner,
			binary: "ssh",
			args: buildMkdirArgv({
				remoteHost: opts.remoteHost,
				remoteUser: opts.remoteUser,
				remotePort: opts.remotePort,
				proxyPath,
				knownHostsFile,
				destination: opts.destination,
			}),
			env,
			signal: opts.signal,
		})

		// 2) rsync.
		const rsyncArgs = buildRsyncArgv({
			source: opts.source,
			destination: opts.destination,
			remoteHost: opts.remoteHost,
			remoteUser: opts.remoteUser,
			remotePort: opts.remotePort,
			proxyPath,
			knownHostsFile,
			excludeFile,
		})
		const stats = await runRsyncChild({
			spawner,
			args: rsyncArgs,
			env,
			signal: opts.signal,
			onProgress: opts.onProgress,
		})

		return {
			fileCount: stats.fileCount,
			totalBytes: stats.totalBytes,
			durationMs: Date.now() - startedAt,
		}
	} finally {
		await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
	}
}

interface RunChildInput {
	spawner: typeof spawn
	binary: string
	args: string[]
	env: NodeJS.ProcessEnv
	signal?: AbortSignal
}

async function runChild(input: RunChildInput): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = ""
		const child = input.spawner(input.binary, input.args, {
			env: input.env,
			signal: input.signal,
			stdio: ["ignore", "ignore", "pipe"],
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8")
		})
		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (code === 0) resolve()
			else reject(new RsyncError(code ?? -1, stderr, `${input.binary} exited with code ${code}`))
		})
	})
}

interface RunRsyncChildInput {
	spawner: typeof spawn
	args: string[]
	env: NodeJS.ProcessEnv
	signal?: AbortSignal
	onProgress?: (pct: number, bytes: number) => void
}

interface RsyncStats {
	fileCount: number
	totalBytes: number
}

const PROGRESS_LINE = /^\s*([\d,]+)\s+(\d+)%/
const NUM_REGULAR_FILES = /^\s*Number of regular files transferred:\s*([\d,]+)/
const TOTAL_TRANSFERRED = /^\s*Total transferred file size:\s*([\d,]+)\s*bytes?/

async function runRsyncChild(input: RunRsyncChildInput): Promise<RsyncStats> {
	return new Promise((resolve, reject) => {
		let stderr = ""
		let buf = ""
		const stats: RsyncStats = { fileCount: 0, totalBytes: 0 }
		let child: ChildProcess
		try {
			child = input.spawner("rsync", input.args, {
				env: input.env,
				signal: input.signal,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (err) {
			reject(err)
			return
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8")
		})
		child.stdout?.on("data", (chunk: Buffer) => {
			// rsync uses \r for in-place progress updates. Normalise to \n so the
			// line splitter sees one tick per update.
			buf += chunk.toString("utf-8").replace(/\r(?!\n)/g, "\n")
			const lines = buf.split("\n")
			buf = lines.pop() ?? ""
			for (const line of lines) handleLine(line, stats, input.onProgress)
		})
		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (buf.length > 0) handleLine(buf, stats, input.onProgress)
			if (code === 0) resolve(stats)
			else reject(new RsyncError(code ?? -1, stderr))
		})
	})
}

function handleLine(line: string, stats: RsyncStats, onProgress?: (pct: number, bytes: number) => void): void {
	const progress = line.match(PROGRESS_LINE)
	if (progress) {
		const bytes = Number(progress[1].replace(/,/g, ""))
		const pct = Number(progress[2])
		if (!Number.isNaN(bytes) && !Number.isNaN(pct)) onProgress?.(pct, bytes)
		return
	}
	const fileCountMatch = line.match(NUM_REGULAR_FILES)
	if (fileCountMatch) {
		stats.fileCount = Number(fileCountMatch[1].replace(/,/g, ""))
		return
	}
	const totalMatch = line.match(TOTAL_TRANSFERRED)
	if (totalMatch) {
		stats.totalBytes = Number(totalMatch[1].replace(/,/g, ""))
	}
}

function shellEscape(value: string): string {
	if (/^[\w/.\-:@%+=]+$/.test(value)) return value
	return `'${value.replace(/'/g, "'\\''")}'`
}

function ensureTrailingSlash(p: string): string {
	return p.endsWith("/") ? p : `${p}/`
}
