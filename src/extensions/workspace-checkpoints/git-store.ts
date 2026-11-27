import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const ZERO_SHA = "0".repeat(40)
const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024
const GENERATED_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"env",
	"dist",
	"build",
	".pytest_cache",
	".mypy_cache",
	".cache",
	".tox",
	"__pycache__",
])

export type SkipReason = "credentials" | "generated" | "large" | "nested repository" | "unreadable"

export interface SkippedPath {
	path: string
	reason: SkipReason
}

export interface CheckpointRecord {
	id: string
	treeSha: string
	branch: string
	sourceHeadSha: string
	createdAt: string
	trigger: string
	label?: string
	validated: boolean
	includedPathCount: number
	includedPathPreview: string[]
	skippedPaths: SkippedPath[]
	deduplicatedFrom?: string
}

export interface CaptureOptions {
	trigger: string
	label?: string
	validated?: boolean
	deduplicate?: boolean
}

interface StatusEntry {
	path: string
	untracked: boolean
}

interface CommandOptions {
	cwd: string
	gitDir?: string
	workTree?: string
	env?: NodeJS.ProcessEnv
}

function normalizeRelative(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
	if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new Error(`Unsafe checkpoint path: ${path}`)
	}
	return normalized
}

function skipped(reason: SkipReason, path: string): SkippedPath {
	return { path, reason }
}

const CREDENTIAL_BASENAMES = new Set([
	".npmrc",
	".netrc",
	".pypirc",
	".pgpass",
	".git-credentials",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"credentials.json",
	"service-account.json",
	"service_account.json",
	"secrets.json",
	"secret.json",
	"token.json",
])

function excluded(path: string, nestedDirectory: boolean): SkippedPath | undefined {
	const parts = path.split("/")
	const name = parts.at(-1) ?? path
	if (
		name === ".env" ||
		name.startsWith(".env.") ||
		CREDENTIAL_BASENAMES.has(name) ||
		parts.some((part) => part === ".ssh" || part === ".gnupg")
	) {
		return skipped("credentials", path)
	}
	if (parts.some((part) => GENERATED_DIRS.has(part))) return skipped("generated", path)
	if (nestedDirectory) return skipped("nested repository", path)
	return undefined
}

/** Git operations for a private object database outside the project. */
export class WorkspaceGitStore {
	private hasCommits = false
	private lastFingerprint?: string

	private constructor(
		readonly root: string,
		readonly gitDir: string,
		private readonly timeoutMs: number,
	) {}

	static async open(root: string, gitDir: string, timeoutMs = 30_000): Promise<WorkspaceGitStore> {
		const canonicalRoot = await realpath(root)
		const store = new WorkspaceGitStore(canonicalRoot, gitDir, timeoutMs)
		await mkdir(dirname(gitDir), { recursive: true, mode: 0o700 })
		await chmod(dirname(gitDir), 0o700)
		await store.run(["init", "--bare", gitDir], { cwd: canonicalRoot })
		await chmod(gitDir, 0o700)
		store.hasCommits = await store
			.privateText(["rev-parse", "--verify", "HEAD^{commit}"])
			.then(() => true)
			.catch(() => false)
		return store
	}

	private async run(args: string[], options: CommandOptions): Promise<Buffer> {
		const fullArgs = [
			...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
			...(options.workTree ? [`--work-tree=${options.workTree}`] : []),
			...args,
		]
		try {
			const { stdout } = await execFileAsync("git", fullArgs, {
				cwd: options.cwd,
				env: options.env,
				timeout: this.timeoutMs,
				killSignal: "SIGTERM",
				maxBuffer: 64 * 1024 * 1024,
				windowsHide: true,
			})
			return Buffer.from(stdout)
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error)
			throw new Error(`git ${args[0]} failed for ${options.cwd}: ${details}`, { cause: error })
		}
	}

	private async main(args: string[]): Promise<string> {
		return (await this.run(args, { cwd: this.root })).toString("utf8").trimEnd()
	}

	private async privateGit(args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
		return this.run(args, { cwd: this.root, gitDir: this.gitDir, workTree: this.root, env })
	}

	private async privateText(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
		return (await this.privateGit(args, env)).toString("utf8").trim()
	}

	async branchState(): Promise<{ branch: string; sourceHeadSha: string }> {
		const branch = await this.main(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "HEAD")
		const sourceHeadSha = await this.main(["rev-parse", "HEAD"]).catch(() => ZERO_SHA)
		return { branch, sourceHeadSha }
	}

	private async statusEntries(): Promise<StatusEntry[]> {
		const output = await this.main(["status", "--porcelain", "-z", "--untracked-files=all"])
		if (!output) return []
		const raw = output.split("\0").filter(Boolean)
		const result: StatusEntry[] = []
		for (let i = 0; i < raw.length; i++) {
			const entry = raw[i]
			const path = entry.slice(3)
			if (path) result.push({ path, untracked: entry.startsWith("??") })
			if (entry.startsWith("R ") || entry.startsWith("C ")) {
				const oldPath = raw[++i]
				if (oldPath) result.push({ path: oldPath, untracked: false })
			}
		}
		return result
	}

	private async pathsToStage(initial: boolean): Promise<{ paths: string[]; skipped: SkippedPath[] }> {
		const seen = new Map<string, boolean>()
		const privateIndex = await this.privateText(["ls-files", "-z"])
		for (const path of privateIndex.split("\0").filter(Boolean)) seen.set(path, false)
		if (initial) {
			const tracked = await this.main(["ls-files", "-z", "--cached"])
			for (const path of tracked.split("\0").filter(Boolean)) seen.set(path, false)
		}
		const statuses = await this.statusEntries()
		for (const entry of statuses) seen.set(entry.path, entry.untracked)
		const paths: string[] = []
		const skippedPaths: SkippedPath[] = []
		for (const [rawPath, untracked] of seen) {
			const skip = excluded(normalizeRelative(rawPath), untracked && rawPath.endsWith("/"))
			if (skip) {
				skippedPaths.push(skip)
				continue
			}
			const path = normalizeRelative(rawPath)
			if (untracked) {
				try {
					const info = await stat(join(this.root, path))
					if (info.isFile() && info.size > MAX_UNTRACKED_BYTES) {
						skippedPaths.push(skipped("large", path))
						continue
					}
				} catch {
					skippedPaths.push(skipped("unreadable", path))
					continue
				}
			}
			paths.push(path)
		}
		return { paths, skipped: skippedPaths }
	}

	private async lastFingerprintFor(paths: string[]): Promise<string> {
		const hash = createHash("sha256")
		for (const path of [...paths].sort()) {
			const info = await lstat(join(this.root, path)).catch(() => undefined)
			hash.update(`${path}:${info?.size ?? 0}:${info?.mode ?? 0}:${info?.mtimeMs ?? 0}:${info?.ctimeMs ?? 0}\0`)
		}
		return hash.digest("hex")
	}

	private async writeTree(
		initial: boolean,
		staged?: { paths: string[]; skipped: SkippedPath[] },
	): Promise<{
		treeSha: string
		includedPathCount: number
		includedPathPreview: string[]
		skippedPaths: SkippedPath[]
	}> {
		const { paths, skipped } = staged ?? (await this.pathsToStage(initial))
		const previousTree = await this.privateText(["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => undefined)
		if (previousTree) await this.privateText(["read-tree", previousTree])
		const indexedPaths = await this.privateText(["ls-files", "-z"])
		for (const path of indexedPaths.split("\0").filter(Boolean)) {
			const missing = (await lstat(join(this.root, path)).catch(() => undefined)) === undefined
			if (excluded(path, false) || missing) {
				await this.privateText(["rm", "--cached", "--", path])
			}
		}
		const existingPaths = []
		for (const path of paths) {
			if (await lstat(join(this.root, path)).catch(() => undefined)) existingPaths.push(path)
		}
		for (let i = 0; i < existingPaths.length; i += 100) {
			await this.privateText(["add", "--all", "--", ...existingPaths.slice(i, i + 100)])
		}
		const treeSha = await this.privateText(["write-tree"])
		const storedPaths = await this.privateText(["ls-tree", "-r", "--name-only", "-z", treeSha])
		const includedPathCount = storedPaths ? storedPaths.split("\0").filter(Boolean).length : 0
		return { treeSha, includedPathCount, includedPathPreview: paths.slice(0, 200), skippedPaths: skipped }
	}

	async commit(options: CaptureOptions): Promise<CheckpointRecord & { unchanged: boolean }> {
		const startedAt = Date.now()
		const previous = this.hasCommits ? await this.privateText(["rev-parse", "HEAD"]) : undefined
		const [{ branch, sourceHeadSha }, staged] = await Promise.all([
			this.branchState(),
			this.pathsToStage(!this.hasCommits),
		])
		const fingerprint = options.deduplicate === false ? undefined : await this.lastFingerprintFor(staged.paths)
		if (options.deduplicate !== false && previous && fingerprint === this.lastFingerprint) {
			const headMessage = await this.privateText(["cat-file", "commit", "HEAD"])
			const previousId = headMessage.match(/^workspace-checkpoint:([^\s]+)$/m)?.[1] ?? previous
			const previousTreeSha = headMessage.match(/^tree (.+)$/m)?.[1]
			if (!previousTreeSha) throw new Error("Missing tree in private checkpoint HEAD")
			return {
				id: previousId,
				treeSha: previousTreeSha,
				branch,
				sourceHeadSha,
				createdAt: new Date(startedAt).toISOString(),
				trigger: options.trigger,
				validated: options.validated === true,
				includedPathCount: staged.paths.length,
				includedPathPreview: staged.paths.slice(0, 200),
				skippedPaths: staged.skipped,
				deduplicatedFrom: previousId,
				unchanged: true,
			}
		}
		const tree = await this.writeTree(!this.hasCommits, staged)
		if (
			options.deduplicate !== false &&
			previous &&
			tree.treeSha === (await this.privateText(["rev-parse", "HEAD^{tree}"]))
		) {
			const headMessage = await this.privateText(["cat-file", "commit", "HEAD"])
			const previousId = headMessage.match(/^workspace-checkpoint:([^\s]+)$/m)?.[1] ?? previous
			this.lastFingerprint = fingerprint
			return {
				id: previousId,
				treeSha: tree.treeSha,
				branch,
				sourceHeadSha,
				createdAt: new Date(startedAt).toISOString(),
				trigger: options.trigger,
				validated: options.validated === true,
				includedPathCount: tree.includedPathCount,
				includedPathPreview: tree.includedPathPreview,
				skippedPaths: tree.skippedPaths,
				deduplicatedFrom: previousId,
				unchanged: true,
			}
		}

		const id = randomUUID()
		const createdAt = new Date(startedAt).toISOString()
		const message = [
			`workspace-checkpoint:${id}`,
			`tree ${tree.treeSha}`,
			`branch ${branch}`,
			...(options.label ? [`label ${options.label}`] : []),
			`validated ${options.validated === true}`,
			`trigger ${options.trigger}`,
		].join("\n")
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: "Kimchi Workspace Checkpoints",
			GIT_AUTHOR_EMAIL: "noreply@kimchi.dev",
			GIT_AUTHOR_DATE: createdAt,
			GIT_COMMITTER_NAME: "Kimchi Workspace Checkpoints",
			GIT_COMMITTER_EMAIL: "noreply@kimchi.dev",
			GIT_COMMITTER_DATE: createdAt,
		}
		const commitSha = await this.privateText(
			["commit-tree", tree.treeSha, ...(previous ? ["-p", previous] : []), "-m", message],
			env,
		)
		await this.privateText(["update-ref", `refs/kimchi-checkpoints/${id}`, commitSha])
		await this.privateText(["symbolic-ref", "HEAD", `refs/kimchi-checkpoints/${id}`])
		this.hasCommits = true
		this.lastFingerprint = fingerprint
		return {
			id,
			treeSha: tree.treeSha,
			branch,
			sourceHeadSha,
			createdAt,
			trigger: options.trigger,
			...(options.label !== undefined ? { label: options.label } : {}),
			validated: options.validated === true,
			includedPathCount: tree.includedPathCount,
			includedPathPreview: tree.includedPathPreview,
			skippedPaths: tree.skippedPaths,
			unchanged: false,
		}
	}

	private async modesForTree(treeSha: string): Promise<Map<string, string>> {
		const modes = new Map<string, string>()
		const rows = await this.privateText(["ls-tree", "-r", "-z", treeSha])
		for (const row of rows.split("\0").filter(Boolean)) {
			const mode = row.slice(0, row.indexOf(" "))
			const path = row.slice(row.indexOf("\t") + 1)
			modes.set(path, mode)
		}
		return modes
	}

	private async restoreFile(treeSha: string, path: string, mode?: string, signal?: AbortSignal): Promise<void> {
		const parent = await this.ensureParent(path)
		const target = join(parent, basename(path))
		const existing = await lstat(target).catch(() => undefined)
		if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symlink ${path}`)
		const content = await this.privateGit(["show", `${treeSha}:${path}`])
		mode ??= await this.privateText(["ls-tree", treeSha, "--", path])
		signal?.throwIfAborted()
		if (mode.split(" ", 1)[0] === "120000") {
			await rm(target, { force: true })
			await symlink(content.toString("utf8"), target)
			return
		}
		await writeFile(target, content)
		if (mode.split(" ", 1)[0] === "100755") await chmod(target, 0o755)
	}

	private async ensureParent(path: string, create = true): Promise<string> {
		const relativeParent = dirname(path)
		const gitDir = await this.main(["rev-parse", "--absolute-git-dir"]).catch(() => join(this.root, ".git"))
		let current = this.root
		for (const component of relativeParent.split("/")) {
			current = join(current, component)
			if (current === gitDir || current.startsWith(`${gitDir}${sep}`)) {
				throw new Error(`Refusing to write into Git metadata through ${path}`)
			}
			const info = await lstat(current).catch(() => undefined)
			if (!info) {
				if (!create) return join(this.root, relativeParent)
				await mkdir(current, { mode: 0o700 })
				continue
			}
			if (info.isSymbolicLink()) throw new Error(`Refusing to follow symlinked checkpoint parent ${current}`)
			if (!info.isDirectory()) throw new Error(`Checkpoint parent is not a directory: ${current}`)
		}
		const canonical = await realpath(join(this.root, relativeParent))
		if (canonical !== this.root && !canonical.startsWith(`${this.root}${sep}`)) {
			throw new Error(`Checkpoint path ${path} resolves outside the workspace`)
		}
		await mkdir(canonical, { recursive: true })
		return canonical
	}

	private async isProjectTracked(path: string): Promise<boolean> {
		return this.main(["ls-files", "--error-unmatch", "--", path])
			.then(() => true)
			.catch(() => false)
	}

	private async assertRestorationTargetsSafe(entries: string[], signal?: AbortSignal): Promise<void> {
		for (let i = 0; i < entries.length; i++) {
			signal?.throwIfAborted()
			const operation = entries[i]
			const path = normalizeRelative(entries[++i])
			const existing = await lstat(join(this.root, path)).catch(() => undefined)
			if (operation === "D" && existing && !(await this.isProjectTracked(path))) continue
			await this.ensureParent(path, false)
			if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symlink ${path}`)
		}
	}

	private async assertSafetyPathsCovered(beforeTree: string, entries: string[], signal?: AbortSignal): Promise<void> {
		for (let i = 0; i < entries.length; i++) {
			signal?.throwIfAborted()
			const operation = entries[i]
			const path = normalizeRelative(entries[++i])
			if (operation === "D") continue
			const target = join(this.root, path)
			const existing = await lstat(target).catch(() => undefined)
			if (!existing) continue
			const current = await readFile(target)
			const preserved = await this.privateText(["cat-file", "-e", `${beforeTree}:${path}`])
				.then(() => true)
				.catch(() => false)
			const safe = await this.privateGit(["show", `${beforeTree}:${path}`]).catch(() => undefined)
			if (!preserved) {
				throw new Error(`Refusing to restore ${path}: its current contents are not covered by the safety checkpoint`)
			}
			if (safe && !safe.equals(current)) {
				throw new Error(`Refusing to restore ${path}: current contents differ from the safety checkpoint`)
			}
		}
	}

	async restore(id: string, signal?: AbortSignal): Promise<{ restoredPaths: number; preservedPaths: string[] }> {
		signal?.throwIfAborted()
		if (!/^[\w-]+$/.test(id)) throw new Error("Invalid checkpoint id")
		const checkpoint = await this.privateText(["rev-parse", "--verify", `refs/kimchi-checkpoints/${id}^{tree}`])
		const beforeTree = await this.privateText(["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => undefined)
		if (!beforeTree) throw new Error("No current checkpoint is available for restoration")
		const [differences, modesByPath] = await Promise.all([
			this.privateGit([
				"diff-tree",
				"--no-commit-id",
				"--no-renames",
				"--name-status",
				"-z",
				"-r",
				beforeTree,
				checkpoint,
			]),
			this.modesForTree(checkpoint),
		])
		const entries = differences.toString("utf8").split("\0").filter(Boolean)
		await this.assertRestorationTargetsSafe(entries, signal)
		await this.assertSafetyPathsCovered(beforeTree, entries, signal)
		let restoredPaths = 0
		const preservedPaths: string[] = []
		for (let i = 0; i < entries.length; i++) {
			const change = entries[i]
			const path = normalizeRelative(entries[++i])
			signal?.throwIfAborted()
			if (change[0] === "D") {
				const existing = await lstat(join(this.root, path)).catch(() => undefined)
				if (!existing) {
					await this.restoreFile(checkpoint, path, modesByPath.get(path), signal)
					restoredPaths++
					continue
				}
				const tracked = await this.isProjectTracked(path)
				// Untracked work may not belong to the candidate. Never delete it
				// merely because it is absent from the selected checkpoint.
				if (!tracked) {
					preservedPaths.push(path)
					continue
				}
				await this.ensureParent(path)
				signal?.throwIfAborted()
				await rm(join(this.root, path), { force: true, recursive: false })
			} else {
				await this.restoreFile(checkpoint, path, modesByPath.get(path), signal)
			}
			restoredPaths++
		}
		return { restoredPaths, preservedPaths }
	}
}

export function storageKey(root: string, sessionId: string): string {
	return createHash("sha256")
		.update(`${resolve(root)}\0${sessionId}`)
		.digest("hex")
		.slice(0, 24)
}

export async function readCheckpointMetadata(dir: string): Promise<CheckpointRecord[]> {
	let names: string[]
	try {
		names = await readdir(dir)
	} catch {
		return []
	}
	const records: CheckpointRecord[] = []
	for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
		try {
			records.push(JSON.parse(await readFile(join(dir, name), "utf8")) as CheckpointRecord)
		} catch (error) {
			console.error(`workspace-checkpoints: could not read ${name}:`, error)
		}
	}
	return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function writeCheckpointMetadata(dir: string, record: CheckpointRecord): Promise<void> {
	await mkdir(dir, { recursive: true })
	const target = join(dir, `${record.id}.json`)
	const temporary = `${target}.${randomUUID()}.tmp`
	await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
	await rename(temporary, target)
}
