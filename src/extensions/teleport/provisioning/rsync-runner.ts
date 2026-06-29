import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname as nodePathDirname, posix } from "node:path"

const posixDirname = posix.dirname
import { estimateUploadBytes } from "./estimate-bytes.js"
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
	/** Precomputed gitignored paths. When set, `runRsync` skips its internal
	 *  `resolveGitIgnored` call (saving the git ls-files subprocess cost) and
	 *  uses these paths directly for both the rsync exclude file and the
	 *  `estimateUploadBytes` denominator. Must match what
	 *  `resolveGitIgnored(localPath)` would return — caller's responsibility.
	 *  Ignored when `includeIgnored` is true, or when `filesFrom` is set. */
	gitignoredPaths?: string[]
	/** Explicit include list (paths relative to `localPath`, POSIX
	 *  separators). When set, rsync is invoked with `--files-from <file>`
	 *  instead of `--exclude-from <file>` and only these files are
	 *  considered for transfer. Far faster than `--exclude-from` for
	 *  trees with a huge gitignored set — no per-file pattern matching.
	 *  Mutually exclusive with `gitignoredPaths` / `excludeGlobs` /
	 *  `includeIgnored`: when `filesFrom` is set, those are ignored. */
	filesFrom?: string[]
	/** Optional progress callback. Fires for each rsync progress tick. Values
	 *  are per-file (rsync's `--progress` shows current-file bytes/%), not
	 *  cumulative — use `onCumulativeProgress` (with `precomputeTotal`) for
	 *  a monotonic total. */
	onProgress?: (pct: number, bytes: number) => void
	/** Optional cumulative-progress callback. Fires only when `precomputeTotal`
	 *  is true. Reports bytes transferred across the whole rsync so far, the
	 *  dry-run-derived total, and the resulting percentage (capped at 99
	 *  until the rsync exits successfully — then a final tick with pct=100
	 *  fires). */
	onCumulativeProgress?: (info: { transferredBytes: number; totalBytes: number; pct: number }) => void
	/** Precomputed estimated upload bytes. When set together with
	 *  `precomputeTotal: true`, runRsync skips its internal estimator (no
	 *  re-walk of the tree, no `onPhase("estimate")` emit) and uses this
	 *  value directly as the cumulative-progress denominator. */
	precomputedTotalBytes?: number
	/** When true, runRsync first walks the local source tree to estimate
	 *  the total upload size (skipping `PRUNE_DIRS` and any path in the
	 *  gitignored set), then reports cumulative progress via
	 *  `onCumulativeProgress` during the real rsync. Local-only — no
	 *  subprocess, no remote roundtrip. Only meaningful for directory
	 *  sources transferred up (local → remote); ignored otherwise. If the
	 *  estimator fails the real rsync still runs but no cumulative
	 *  progress is reported. */
	precomputeTotal?: boolean
	/** Optional phase callback. Fires with "estimate" before the local
	 *  file-walk estimator (only when `precomputeTotal` is true), "mkdir"
	 *  before the pre-flight ssh mkdir step, and "rsync" before the real
	 *  rsync child is spawned. Lets the caller switch status text per step.
	 */
	onPhase?: (phase: "estimate" | "mkdir" | "rsync") => void
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

/** Build a user-facing message for a failed rsync, including a head of its stderr. */
export function formatRsyncFailure(err: unknown): string {
	if (err instanceof RsyncError) {
		const stderrHead = err.stderr?.trim().slice(0, 1500) ?? ""
		return stderrHead ? `${err.message}\nstderr:\n${stderrHead}` : err.message
	}
	return err instanceof Error ? err.message : String(err)
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

export type RsyncListMode = { kind: "exclude-from"; file: string } | { kind: "files-from"; file: string }

interface BuildRsyncArgvInput {
	localPath: string
	remotePath: string
	remoteHost: string
	remoteUser: string
	proxyCommand: string
	knownHostsFile: string
	/** Either an `--exclude-from` patterns file or a `--files-from` explicit
	 *  include list. The runner chooses based on whether the caller supplied
	 *  an explicit `filesFrom` list. */
	listMode: RsyncListMode
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
 *
 * `--files-from` mode is far faster than `--exclude-from` for trees with
 * a huge gitignored set — rsync just walks the supplied list instead of
 * scanning everything and matching every file against every pattern.
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
	if (input.listMode.kind === "files-from") {
		args.push("--files-from", input.listMode.file)
	} else {
		args.push("--exclude-from", input.listMode.file)
	}
	args.push("-e", sshOption)
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
 * Run `git ls-files --cached --others --ignored --exclude-standard` against
 * `cwd`. Returns every path git considers ignored — both untracked files
 * matching `.gitignore` patterns *and* tracked files that nonetheless match
 * (e.g. files committed before the pattern was added, or force-added via
 * `git add -f`). Without `--cached`, that second class slips through and
 * gets rsynced to the sandbox even though the user expects gitignore to
 * keep them local.
 *
 * Returns an empty array if the directory is not a git repository (git
 * exits non-zero) or git is not installed.
 */
export async function resolveGitIgnored(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = spawn,
): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		const child = spawner("git", ["ls-files", "--cached", "--others", "--ignored", "--exclude-standard"], {
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
	const dir = opts.direction ?? "up"

	try {
		await mkdir(sessionDir, { recursive: true })
		await writeFile(knownHostsFile, "", "utf-8")

		// Two list-file modes, mutually exclusive: `--files-from` (explicit
		// include list, far faster on huge gitignored trees) or
		// `--exclude-from` (the legacy path used by `/sync`). The caller
		// picks via the `filesFrom` option.
		let listMode: RsyncListMode
		let gitignoredPaths: string[] = []
		if (opts.filesFrom?.length) {
			const filesFromFile = join(sessionDir, "files-from")
			await writeFile(filesFromFile, `${opts.filesFrom.join("\n")}\n`, "utf-8")
			listMode = { kind: "files-from", file: filesFromFile }
		} else {
			// Base excludes and gitignore filtering only make sense when syncing a
			// whole directory. For an explicit single-file source the user named
			// the file by hand — applying excludes could silently skip it (e.g.
			// `.env` matching BASE_EXCLUDE_GLOBS). Caller-supplied --exclude
			// patterns are still honored either way since they're explicit intent.
			let excludeList: string[]
			if (opts.isSourceDirectory) {
				gitignoredPaths = opts.includeIgnored
					? []
					: (opts.gitignoredPaths ?? (await resolveGitIgnored(opts.localPath, opts.signal, spawner)))
				excludeList = buildExcludeList({ extras: opts.excludeGlobs, gitignored: gitignoredPaths })
			} else {
				excludeList = [...(opts.excludeGlobs ?? [])]
			}
			const excludeFile = join(sessionDir, "excludes")
			await writeFile(excludeFile, `${excludeList.join("\n")}\n`, "utf-8")
			listMode = { kind: "exclude-from", file: excludeFile }
		}

		const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: opts.authToken }

		const proxyCommand = opts.proxyCommand ?? buildProxyCommand()

		const rsyncArgs = buildRsyncArgv({
			localPath: opts.localPath,
			remotePath: opts.remotePath,
			remoteHost: opts.remoteHost,
			remoteUser: opts.remoteUser,
			proxyCommand,
			knownHostsFile,
			listMode,
			deleteExtraneous: opts.deleteExtraneous,
			direction: dir,
			dryRun: opts.dryRun,
		})

		// 1) Optional local-walk pre-pass to estimate the total transfer size.
		//    Used to drive cumulative progress in the real run. This is a
		//    fast local heuristic — no remote roundtrip, no rsync subprocess
		//    — that prunes the same hardcoded noisy dirs as the exclude
		//    file and additionally subtracts every path in the gitignored
		//    set we just computed. An estimator failure is non-fatal: we
		//    fall back to running without cumulative progress.
		let estimatedTotalBytes = 0
		if (opts.precomputeTotal && !opts.dryRun && opts.isSourceDirectory && dir === "up") {
			if (opts.precomputedTotalBytes !== undefined) {
				estimatedTotalBytes = opts.precomputedTotalBytes
			} else if (!opts.filesFrom) {
				// Fallback estimator only applies in `--exclude-from` mode where
				// the gitignored set is meaningful for the walker. With
				// `--files-from` the caller has an exact list and is responsible
				// for precomputing total bytes themselves (otherwise no
				// cumulative progress will be reported).
				opts.onPhase?.("estimate")
				try {
					estimatedTotalBytes = await estimateUploadBytes(opts.localPath, new Set(gitignoredPaths), opts.signal)
				} catch {
					// Swallow; the real run below will still execute. We just lose
					// the cumulative progress denominator for this teleport.
					estimatedTotalBytes = 0
				}
			}
		}

		// 2) Pre-create the destination directory so rsync has somewhere to land.
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

		// 3) Real rsync. Cumulative tracking only runs when we got a usable
		//    total from the local estimator.
		opts.onPhase?.("rsync")
		const cumulative =
			estimatedTotalBytes > 0 && opts.onCumulativeProgress
				? { totalBytes: estimatedTotalBytes, onCumulativeProgress: opts.onCumulativeProgress }
				: undefined
		const stats = await runRsyncChild({
			spawner,
			args: rsyncArgs,
			env,
			signal: opts.signal,
			onProgress: opts.onProgress,
			cumulative,
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

interface CumulativeInput {
	totalBytes: number
	onCumulativeProgress: (info: { transferredBytes: number; totalBytes: number; pct: number }) => void
}

interface RunRsyncChildInput {
	spawner: typeof spawn
	args: string[]
	env: NodeJS.ProcessEnv
	signal?: AbortSignal
	onProgress?: (pct: number, bytes: number) => void
	cumulative?: CumulativeInput
}

export interface RsyncStats {
	fileCount: number
	totalBytes: number
}

export interface CumulativeState {
	completedBytes: number
	currentFileBytes: number
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
		const cumState: CumulativeState = { completedBytes: 0, currentFileBytes: 0 }
		const cum = input.cumulative
		const onLine = (line: string) => {
			handleLine(line, stats, input.onProgress)
			if (cum) {
				if (trackCumulative(line, cumState)) {
					const transferred = cumState.completedBytes + cumState.currentFileBytes
					const pct = Math.min(99, Math.round((transferred / cum.totalBytes) * 100))
					cum.onCumulativeProgress({ transferredBytes: transferred, totalBytes: cum.totalBytes, pct })
				}
			}
		}
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
			for (const line of lines) onLine(line)
		})
		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (buf.length > 0) onLine(buf)
			if (code === 0) {
				if (cum) {
					cum.onCumulativeProgress({
						transferredBytes: cum.totalBytes,
						totalBytes: cum.totalBytes,
						pct: 100,
					})
				}
				resolve(stats)
			} else reject(new RsyncError(code ?? -1, stderr))
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

/**
 * Exported for testing — updates cumulative byte tracking from a single
 * rsync stdout line. Returns true when the caller should emit a cumulative
 * progress update.
 *
 * File boundary detection is flavor-agnostic: a path line is any non-empty
 * line that doesn't match `PROGRESS_LINE`. When we see one (and we've
 * previously accumulated bytes for an in-flight file), the current file is
 * done and its last reported byte count rolls into `completedBytes`. Stats
 * lines (which appear after the last transfer) also count as boundaries,
 * which is fine — the post-boundary state (currentFileBytes=0) prevents
 * any double-counting from subsequent stats lines.
 */
export function trackCumulative(line: string, state: CumulativeState): boolean {
	const progress = line.match(PROGRESS_LINE)
	if (progress) {
		const bytes = Number(progress[1].replace(/,/g, ""))
		if (!Number.isNaN(bytes)) {
			state.currentFileBytes = bytes
			return true
		}
		return false
	}
	if (line.trim().length > 0 && state.currentFileBytes > 0) {
		state.completedBytes += state.currentFileBytes
		state.currentFileBytes = 0
		return true
	}
	return false
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
