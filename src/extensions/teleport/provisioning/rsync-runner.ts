import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname as nodePathDirname, posix } from "node:path"

const posixDirname = posix.dirname
import { buildProxyCommand } from "./proxy-command.js"

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
	/** Absolute path on the local filesystem. Source when direction is "up",
	 *  target when direction is "down". */
	localPath: string
	/** Path on the remote sandbox. Target when direction is "up", source when
	 *  direction is "down". */
	remotePath: string
	/** Hostname of the session host (expanded by ssh's %h in ProxyCommand). */
	remoteHost: string
	/** SSH user to log in as on the sandbox. */
	remoteUser: string
	/** Bearer token surfaced to teleport-proxy via the AUTH_TOKEN env var. */
	authToken: string
	/**
	 * Whether the *source* of the transfer is a directory. Controls whether
	 * the base excludes + gitignore filter are applied (directories) or
	 * skipped (single files — the user named them explicitly). Also
	 * determines whether the pre-flight mkdir creates the whole target or
	 * just its parent dir.
	 */
	isSourceDirectory: boolean
	/** Caller-supplied additional excludes (appended after gitignored ones). */
	excludeGlobs?: string[]
	/** Skip the `git ls-files --others --ignored --exclude-standard` step.
	 *  Only meaningful when `isSourceDirectory` is true. */
	includeIgnored?: boolean
	/** Optional progress callback. Fires for each rsync progress2 tick. */
	onProgress?: (pct: number, bytes: number) => void
	/** Optional phase callback. Fires once with "mkdir" immediately before the
	 *  pre-flight ssh mkdir step, and once with "rsync" immediately before the
	 *  rsync child is spawned. Lets the caller switch status text per step.
	 */
	onPhase?: (phase: "mkdir" | "rsync") => void
	/** Cancellation. Kills the running ssh/rsync children if it fires. */
	signal?: AbortSignal
	/** If false, omits the `--delete` flag so the remote keeps pre-existing files. */
	deleteExtraneous?: boolean
	/**
	 * Transfer direction.
	 * - `"up"` (default): local → remote.
	 * - `"down"`: remote → local.
	 */
	direction?: "up" | "down"
	/**
	 * When true, passes `--dry-run` to rsync so it reports what *would* be
	 * transferred without actually writing anything.
	 */
	dryRun?: boolean
	/** Override path to the vendored teleport-proxy.js. Defaults to the one
	 *  shipped with this module. Tests inject a stub.
	 */
	proxyCommand?: string
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

interface BuildSshOptionInput {
	proxyCommand: string
	knownHostsFile: string
}

/**
 * Builds the SSH command string that rsync's `-e` (or stand-alone ssh) uses.
 * The ProxyCommand chains the local node proxy that bridges the WS tunnel.
 * StrictHostKeyChecking=accept-new accepts the sandbox's ephemeral host key
 * on first contact; we trust the WSS endpoint's TLS for identity. The `-p`
 * flag fills `%p` in the ProxyCommand so the proxy connects to the right
 * WSS port — rsync's own `--port` is for daemon mode, not ssh transport.
 */
export function buildSshOption(input: BuildSshOptionInput): string {
	// IMPORTANT: rsync's `-e` parser re-splits this whole string on
	// whitespace (respecting POSIX single quotes) before exec'ing ssh. Any
	// option value containing literal spaces — most notably the
	// ProxyCommand value, which embeds `%h %p` for ssh to substitute — has
	// to be single-quoted or rsync turns the trailing words into stray
	// positional ssh args. UserKnownHostsFile gets the same treatment as a
	// defensive measure (some $TMPDIR layouts have spaces).
	return [
		"ssh",
		"-o",
		`ProxyCommand=${rsyncShellQuote(input.proxyCommand)}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${rsyncShellQuote(input.knownHostsFile)}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=15",
	].join(" ")
}

interface BuildRsyncArgvInput {
	localPath: string
	remotePath: string
	remoteHost: string
	remoteUser: string
	proxyCommand: string
	knownHostsFile: string
	excludeFile: string
	deleteExtraneous?: boolean
	/** Transfer direction: "up" = local→remote (default), "down" = remote→local. */
	direction?: "up" | "down"
	/** When true, appends `--dry-run` so rsync previews without writing. */
	dryRun?: boolean
}

/**
 * Pure helper: assembles the rsync argv. Caller is responsible for running it.
 *
 * Paths are passed to rsync verbatim — the trailing-slash convention
 * ("foo/" copies *contents* of foo, "foo" copies the dir itself) is owned
 * by the caller. For single files, the caller passes the file path directly
 * and rsync handles the file → file or file → dir cases natively.
 */
export function buildRsyncArgv(input: BuildRsyncArgvInput): string[] {
	const sshOption = buildSshOption({
		proxyCommand: input.proxyCommand,
		knownHostsFile: input.knownHostsFile,
	})
	// `--progress` works on both GNU rsync 3.x and the BSD rsync 2.6.9 shipped on
	// macOS. The newer `--info=progress2` would give nicer multi-file totals but
	// errors out on BSD rsync with a usage dump, which is way worse UX.
	const args: string[] = ["-az", "--progress", "--stats", "--partial"]
	args.push("--exclude-from", input.excludeFile, "-e", sshOption)
	if (input.deleteExtraneous !== false) args.push("--delete")
	if (input.dryRun) args.push("--dry-run")

	const dir = input.direction ?? "up"
	const remoteSpec = `${input.remoteUser}@${input.remoteHost}:${input.remotePath}`
	if (dir === "down") {
		args.push(remoteSpec)
		args.push(input.localPath)
	} else {
		args.push(input.localPath)
		args.push(remoteSpec)
	}
	return args
}

interface BuildMkdirArgvInput {
	remoteHost: string
	remoteUser: string
	proxyCommand: string
	knownHostsFile: string
	/** Directory to create on the remote (pre-rsync). */
	remoteDir: string
}

/**
 * Pure helper: assembles the ssh argv that pre-creates a directory on the
 * sandbox. Must run before rsync so the target (or its parent, for single
 * files) exists.
 */
export function buildMkdirArgv(input: BuildMkdirArgvInput): string[] {
	return [
		"-o",
		`ProxyCommand=${input.proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${input.knownHostsFile}`,
		"-o",
		"BatchMode=yes",
		`${input.remoteUser}@${input.remoteHost}`,
		`mkdir -p ${input.remoteDir}`,
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
			resolve([])
		})
		child.on("close", (code) => {
			if (code !== 0) {
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
 * via `ssh ... mkdir -p`, then runs rsync with `--progress --stats`.
 *
 * Always cleans up the per-session known_hosts directory on both success and
 * failure paths. The caller's pre-flight (clean working tree, rsync installed,
 * size warning) is out of scope here.
 */
export async function runRsync(opts: RsyncOptions): Promise<RsyncResult> {
	const startedAt = Date.now()
	const spawner = opts._spawn ?? spawn
	const sessionDir = join(tmpdir(), `kimchi-teleport-${randomUUID()}`)
	const knownHostsFile = join(sessionDir, "known_hosts")
	const excludeFile = join(sessionDir, "excludes")
	const dir = opts.direction ?? "up"

	try {
		await mkdir(sessionDir, { recursive: true })
		await writeFile(knownHostsFile, "", "utf-8")

		// Base excludes and gitignore filtering only make sense when syncing a
		// whole directory. For an explicit single-file source the user named
		// the file by hand — applying excludes could silently skip it (e.g.
		// `.env` matching BASE_EXCLUDE_GLOBS). Caller-supplied --exclude
		// patterns are still honored either way since they're explicit intent.
		let excludeList: string[]
		if (opts.isSourceDirectory) {
			const gitignored = opts.includeIgnored ? [] : await resolveGitIgnored(opts.localPath, opts.signal, spawner)
			excludeList = buildExcludeList({ extras: opts.excludeGlobs, gitignored })
		} else {
			excludeList = [...(opts.excludeGlobs ?? [])]
		}
		await writeFile(excludeFile, `${excludeList.join("\n")}\n`, "utf-8")

		const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: opts.authToken }

		const proxyCommand = opts.proxyCommand ?? buildProxyCommand()

		// 1) Pre-create the destination directory so rsync has somewhere to land.
		//    For directory sources we create the whole target; for single-file
		//    sources we create the *parent* of the target (rsync will write the
		//    file itself).
		opts.onPhase?.("mkdir")
		if (dir === "down") {
			const localDir = opts.isSourceDirectory ? opts.localPath : nodePathDirname(opts.localPath)
			await mkdir(localDir, { recursive: true })
		} else {
			const remoteDir = opts.isSourceDirectory ? opts.remotePath : posixDirname(opts.remotePath)
			await runChild({
				spawner,
				binary: "ssh",
				args: buildMkdirArgv({
					remoteHost: opts.remoteHost,
					remoteUser: opts.remoteUser,
					proxyCommand,
					knownHostsFile,
					remoteDir,
				}),
				env,
				signal: opts.signal,
			})
		}

		// 2) rsync.
		opts.onPhase?.("rsync")
		const rsyncArgs = buildRsyncArgv({
			localPath: opts.localPath,
			remotePath: opts.remotePath,
			remoteHost: opts.remoteHost,
			remoteUser: opts.remoteUser,
			proxyCommand,
			knownHostsFile,
			excludeFile,
			deleteExtraneous: opts.deleteExtraneous,
			direction: dir,
			dryRun: opts.dryRun,
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

export interface RsyncStats {
	fileCount: number
	totalBytes: number
}

const PROGRESS_LINE = /^\s*([\d,]+)\s+(\d+)%/
// GNU rsync 3.x: "Number of regular files transferred: 24"
// GNU rsync 2.x / openrsync: "Number of files transferred: 2"
const NUM_FILES_TRANSFERRED = /^\s*Number of (?:regular )?files transferred:\s*([\d,]+)/
// GNU rsync: "Total transferred file size: 121.67K bytes" or "… 12 bytes"
// openrsync: "Total transferred file size: 12 B"
const TOTAL_TRANSFERRED = /^\s*Total transferred file size:\s*([\d,.]+)\s*([KMGTP]?)\s*(?:bytes?|B)/i

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

/** SI suffix multipliers used by rsync's human-readable output. */
const SUFFIX_MULTIPLIER: Record<string, number> = {
	"": 1,
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4,
	P: 1024 ** 5,
}

/** Exported for testing — parses a single rsync stdout line and updates stats. */
export function handleLine(line: string, stats: RsyncStats, onProgress?: (pct: number, bytes: number) => void): void {
	const progress = line.match(PROGRESS_LINE)
	if (progress) {
		const bytes = Number(progress[1].replace(/,/g, ""))
		const pct = Number(progress[2])
		if (!Number.isNaN(bytes) && !Number.isNaN(pct)) onProgress?.(pct, bytes)
		return
	}
	const fileCountMatch = line.match(NUM_FILES_TRANSFERRED)
	if (fileCountMatch) {
		stats.fileCount = Number(fileCountMatch[1].replace(/,/g, ""))
		return
	}
	const totalMatch = line.match(TOTAL_TRANSFERRED)
	if (totalMatch) {
		const raw = Number(totalMatch[1].replace(/,/g, ""))
		const suffix = (totalMatch[2] ?? "").toUpperCase()
		const multiplier = SUFFIX_MULTIPLIER[suffix] ?? 1
		stats.totalBytes = Math.round(raw * multiplier)
	}
}

/**
 * Single-quote `value` so that rsync's `-e` word splitter preserves it as
 * one token when re-tokenising the ssh command. Always wraps in single
 * quotes — values containing literal spaces (e.g. `node /path/proxy.js %h %p`,
 * which intentionally has the `%h %p` placeholders) must survive rsync's
 * splitter intact.
 */
function rsyncShellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}
