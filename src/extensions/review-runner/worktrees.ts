import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import { gitBytes, gitResultError, gitText, repositoryRoot } from "../review-targets/git.js"
import { cleanupReviewSnapshot } from "../review-targets/resolve.js"
import type {
	RecoveredReviewWorktrees,
	RecoverReviewWorktreesOptions,
	ReviewCheckoutKind,
	ReviewRevision,
	ReviewWorktree,
	ReviewWorktreeLease,
	ReviewWorktreeOptions,
	ReviewWorktreePool,
} from "./types.js"

const MANIFEST = "review-worktrees.json"
const MANIFEST_VERSION = "review-worktrees/v1"
const DEFAULT_ROOT = join(tmpdir(), "kimchi-review-worktrees")
const CLEANUP_TIMEOUT_MS = 30_000
const repositoryTails = new Map<string, Promise<void>>()

interface WorktreeManifestEntry {
	id: string
	kind: ReviewCheckoutKind
	revision: ReviewRevision
	path: string
	pinnedSha: string
	status: "pending" | "ready"
}

interface WorktreeManifest {
	schema_version: typeof MANIFEST_VERSION
	repository: string
	contextDir: string
	outputDir: string
	baseSha: string
	headSha: string
	snapshotRef?: string
	createdAt: number
	updatedAt: number
	worktrees: WorktreeManifestEntry[]
}

function contained(parent: string, candidate: string): boolean {
	const remainder = relative(parent, candidate)
	return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
}

function assertOutside(repository: string, contextDir: string, outputDir: string, candidate: string): void {
	for (const [label, forbidden] of [
		["checkout", repository],
		["review context", contextDir],
		["review output", outputDir],
	] as const) {
		if (contained(forbidden, candidate) || contained(candidate, forbidden)) {
			throw new Error(`Reviewer worktree state ${candidate} must be separate from the ${label} directory ${forbidden}.`)
		}
	}
}

async function checkedDirectory(path: string): Promise<string> {
	const checked = await checkReviewDirectory(path, { isDefault: false, create: true })
	if (checked.kind !== "ready") {
		throw new Error(
			`Reviewer worktree directory ${path} is ${checked.kind}${checked.kind === "unsafe" ? `: ${checked.reason}` : "."}`,
		)
	}
	return checked.path
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

async function serializeRepository<T>(repository: string, operation: () => Promise<T>): Promise<T> {
	const previous = repositoryTails.get(repository) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolveRelease) => {
		release = resolveRelease
	})
	const tail = previous.catch(() => {}).then(() => current)
	repositoryTails.set(repository, tail)
	await previous.catch(() => {})
	try {
		return await operation()
	} finally {
		release()
		if (repositoryTails.get(repository) === tail) repositoryTails.delete(repository)
	}
}

async function atomicJson(path: string, value: unknown, exclusive = false): Promise<void> {
	if (exclusive) {
		const handle = await open(path, "wx", 0o600)
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}
		return
	}
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
	try {
		await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true }).catch(() => {})
	}
}

function safeName(id: string): string {
	const readable =
		id
			.replace(/[^A-Za-z0-9_.-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 48) || "reviewer"
	return `${readable}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`
}

function revisionSha(revision: ReviewRevision, baseSha: string, headSha: string): string {
	return revision === "base" ? baseSha : headSha
}

function worktreeEnvironment(worktree: Omit<ReviewWorktree, "env">): Record<string, string> {
	const cache = (...parts: string[]) => join(worktree.cacheDir, ...parts)
	return {
		HOME: worktree.homeDir,
		TMPDIR: worktree.scratchDir,
		TMP: worktree.scratchDir,
		TEMP: worktree.scratchDir,
		XDG_CACHE_HOME: cache("xdg"),
		XDG_CONFIG_HOME: join(worktree.homeDir, ".config"),
		XDG_DATA_HOME: join(worktree.homeDir, ".local", "share"),
		npm_config_cache: cache("npm"),
		PNPM_STORE_PATH: cache("pnpm-store"),
		YARN_CACHE_FOLDER: cache("yarn"),
		GOPATH: cache("go"),
		GOMODCACHE: cache("go", "pkg", "mod"),
		GOCACHE: cache("go-build"),
		GOTMPDIR: worktree.scratchDir,
		PIP_CACHE_DIR: cache("pip"),
		UV_CACHE_DIR: cache("uv"),
		POETRY_CACHE_DIR: cache("poetry"),
		CARGO_HOME: cache("cargo"),
		CARGO_TARGET_DIR: join(worktree.buildDir, "cargo-target"),
		GRADLE_USER_HOME: cache("gradle"),
		COMPOSER_HOME: cache("composer-home"),
		COMPOSER_CACHE_DIR: cache("composer"),
		BUNDLE_PATH: join(worktree.buildDir, "bundle"),
		DENO_DIR: cache("deno"),
		COREPACK_HOME: cache("corepack"),
		NPM_CONFIG_USERCONFIG: join(worktree.homeDir, ".npmrc"),
		NPM_CONFIG_GLOBALCONFIG: join(worktree.homeDir, ".npmrc-global"),
		KIMCHI_REVIEW_WORKTREE: worktree.path,
		KIMCHI_REVIEW_SCRATCH_DIR: worktree.scratchDir,
	}
}

class WorktreePool implements ReviewWorktreePool {
	private readonly worktrees = new Map<string, ReviewWorktree>()
	private readonly entries = new Map<string, WorktreeManifestEntry>()
	private readonly pending = new Map<string, Promise<ReviewWorktree>>()
	private readonly waiters: Array<{
		id: string
		signal?: AbortSignal
		onAbort?: () => void
		resolve: (lease: ReviewWorktreeLease) => void
		reject: (error: unknown) => void
	}> = []
	private activeLeases = 0
	private cleaned = false
	private cleanupPromise?: Promise<void>

	constructor(
		readonly scope: ReviewWorktreeOptions["target"]["scope"],
		readonly runDir: string,
		private readonly repository: string,
		private readonly concurrency: number,
		private readonly releaseTarget: () => Promise<void>,
		private readonly manifest: WorktreeManifest,
		private readonly crashPoint?: ReviewWorktreeOptions["worktreeCrashPoint"],
	) {}

	async getWorktree(
		id: string,
		options: { kind?: ReviewCheckoutKind; revision?: ReviewRevision } = {},
	): Promise<ReviewWorktree> {
		if (this.cleaned) throw new Error("Reviewer worktrees have already been cleaned up.")
		if (!id) throw new Error("A reviewer or check worktree requires a stable non-empty ID.")
		const kind = options.kind ?? "reviewer"
		const revision = options.revision ?? "head"
		const key = `${kind}:${revision}:${id}`
		const existing = this.worktrees.get(key)
		if (existing) return existing
		const pending = this.pending.get(key)
		if (pending) return pending
		const creation = this.createWorktree(key, id, kind, revision).finally(() => this.pending.delete(key))
		this.pending.set(key, creation)
		return creation
	}

	private async createWorktree(
		key: string,
		id: string,
		kind: ReviewCheckoutKind,
		revision: ReviewRevision,
	): Promise<ReviewWorktree> {
		return serializeRepository(this.repository, async () => {
			const existing = this.worktrees.get(key)
			if (existing) return existing
			const directory = join(this.runDir, safeName(key))
			const path = join(directory, "checkout")
			const worktreeBase = {
				id,
				kind,
				revision,
				path,
				pinnedSha: revisionSha(revision, this.manifest.baseSha, this.manifest.headSha),
				scratchDir: join(directory, "scratch"),
				buildDir: join(directory, "build"),
				cacheDir: join(directory, "cache"),
				homeDir: join(directory, "home"),
			}
			const entry: WorktreeManifestEntry = {
				id,
				kind,
				revision,
				path,
				pinnedSha: worktreeBase.pinnedSha,
				status: "pending",
			}
			try {
				await mkdir(directory, { recursive: true, mode: 0o700 })
				await Promise.all(
					[worktreeBase.scratchDir, worktreeBase.buildDir, worktreeBase.cacheDir, worktreeBase.homeDir].map((part) =>
						mkdir(part, { recursive: true, mode: 0o700 }),
					),
				)
				this.entries.set(key, entry)
				this.manifest.worktrees = [...this.entries.values()]
				this.manifest.updatedAt = Date.now()
				await atomicJson(join(this.runDir, MANIFEST), this.manifest)
				await this.crashPoint?.("before-add", { path, runDir: this.runDir })
				await gitText(this.repository, ["worktree", "add", "--detach", path, worktreeBase.pinnedSha], {
					signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
				})
				await this.crashPoint?.("after-add", { path, runDir: this.runDir })
				entry.status = "ready"
				this.entries.set(key, entry)
				this.manifest.worktrees = [...this.entries.values()]
				this.manifest.updatedAt = Date.now()
				await atomicJson(join(this.runDir, MANIFEST), this.manifest)
				const worktree: ReviewWorktree = { ...worktreeBase, env: worktreeEnvironment(worktreeBase) }
				this.worktrees.set(key, worktree)
				return worktree
			} catch (error) {
				await rm(path, { recursive: true, force: true }).catch(() => {})
				await gitText(this.repository, ["worktree", "prune"], {
					signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
				}).catch(() => {})
				throw error
			}
		})
	}

	async leaseReviewer(id: string, options: { signal?: AbortSignal } = {}): Promise<ReviewWorktreeLease> {
		if (this.cleaned) throw new Error("Reviewer worktrees have already been cleaned up.")
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Reviewer worktree lease was cancelled.")
		await this.getWorktree(id, { kind: "reviewer", revision: "head" })
		return new Promise<ReviewWorktreeLease>((resolveLease, reject) => {
			const waiter: (typeof this.waiters)[number] = {
				id,
				signal: options.signal,
				resolve: resolveLease,
				reject,
			}
			if (options.signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter)
					if (index >= 0) this.waiters.splice(index, 1)
					reject(options.signal?.reason ?? new Error("Reviewer worktree lease was cancelled."))
					this.drainLeases()
				}
				options.signal.addEventListener("abort", waiter.onAbort, { once: true })
			}
			this.waiters.push(waiter)
			this.drainLeases()
		})
	}

	private drainLeases(): void {
		while (!this.cleaned && this.activeLeases < this.concurrency && this.waiters.length) {
			const waiter = this.waiters.shift()
			if (!waiter || waiter.signal?.aborted) continue
			waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}))
			this.activeLeases += 1
			void this.getWorktree(waiter.id).then(
				(worktree) => {
					let released = false
					waiter.resolve({
						worktree,
						release: () => {
							if (released) return
							released = true
							this.activeLeases = Math.max(0, this.activeLeases - 1)
							this.drainLeases()
						},
					})
				},
				(error) => {
					this.activeLeases = Math.max(0, this.activeLeases - 1)
					waiter.reject(error)
					this.drainLeases()
				},
			)
		}
	}

	cleanup = (): Promise<void> => {
		if (this.cleanupPromise) return this.cleanupPromise
		this.cleaned = true
		for (const waiter of this.waiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}))
			waiter.reject(new Error("Reviewer worktrees were cleaned up before a lease became available."))
		}
		const operation = serializeRepository(this.repository, async () => {
			const failures: unknown[] = []
			for (const entry of [...this.entries.values()].reverse()) {
				try {
					if (await pathExists(entry.path)) {
						await gitText(this.repository, ["worktree", "remove", "--force", entry.path], {
							signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
						})
					}
				} catch (error) {
					failures.push(error)
				}
			}
			if (failures.length) {
				this.cleaned = false
				throw new AggregateError(failures, "Could not remove every reviewer worktree; the snapshot ref remains pinned.")
			}
			await removeRunContentsExceptManifest(this.runDir)
			await gitText(this.repository, ["worktree", "prune"], { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) })
			await this.releaseTarget()
			await rm(this.runDir, { recursive: true, force: true })
		})
		this.cleanupPromise = operation.catch((error) => {
			this.cleanupPromise = undefined
			throw error
		})
		return this.cleanupPromise
	}
}

export async function createReviewWorktreePool(options: ReviewWorktreeOptions): Promise<ReviewWorktreePool> {
	if (!Number.isSafeInteger(options.concurrency ?? 1) || (options.concurrency ?? 1) < 1) {
		throw new Error("Reviewer worktree concurrency must be a positive integer.")
	}
	options.signal?.throwIfAborted()
	const repository = await repositoryRoot(options.target.scope.checkoutPath, options.signal)
	const rootParent = await checkedDirectory(resolve(options.rootDir ?? DEFAULT_ROOT))
	const contextDir = resolve(options.target.scope.contextDir)
	const outputDir = resolve(options.outputDir)
	assertOutside(repository, contextDir, outputDir, rootParent)
	const runDir = join(rootParent, `${safeName(basename(repository))}-${randomUUID()}`)
	await mkdir(runDir, { mode: 0o700 })
	const scope = options.target.scope
	const manifest: WorktreeManifest = {
		schema_version: MANIFEST_VERSION,
		repository,
		contextDir,
		outputDir,
		baseSha: scope.pinned.baseSha,
		headSha: scope.pinned.headSha,
		...(scope.pinned.snapshotRef ? { snapshotRef: scope.pinned.snapshotRef } : {}),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		worktrees: [],
	}
	try {
		await atomicJson(join(runDir, MANIFEST), manifest, true)
		return new WorktreePool(
			scope,
			runDir,
			repository,
			options.concurrency ?? 1,
			options.target.cleanup,
			manifest,
			options.worktreeCrashPoint,
		)
	} catch (error) {
		await rm(runDir, { recursive: true, force: true }).catch(() => {})
		await options.target.cleanup().catch(() => {})
		throw error
	}
}

function parseManifest(runDir: string, value: unknown): WorktreeManifest {
	if (!value || typeof value !== "object") throw new Error("Reviewer worktree manifest is not an object.")
	const manifest = value as Partial<WorktreeManifest>
	if (manifest.schema_version !== MANIFEST_VERSION || typeof manifest.repository !== "string") {
		throw new Error("Reviewer worktree manifest has an unsupported schema.")
	}
	for (const key of ["contextDir", "outputDir", "baseSha", "headSha"] as const) {
		if (typeof manifest[key] !== "string") throw new Error(`Reviewer worktree manifest has no ${key}.`)
	}
	if (!Array.isArray(manifest.worktrees)) throw new Error("Reviewer worktree manifest has no worktree list.")
	for (const entry of manifest.worktrees) {
		if (!entry || typeof entry.path !== "string" || !contained(runDir, entry.path) || entry.path === runDir) {
			throw new Error("Reviewer worktree manifest contains an unsafe path.")
		}
	}
	return manifest as WorktreeManifest
}

async function removeRunContentsExceptManifest(runDir: string): Promise<void> {
	for (const entry of await readdir(runDir)) {
		if (entry === MANIFEST) continue
		await rm(join(runDir, entry), { recursive: true, force: true })
	}
}

async function ownedReviewWorktreeRegistrations(
	repository: string,
	runDir: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const output = await gitText(repository, ["worktree", "list", "--porcelain"], { signal })
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => contained(runDir, path))
}

/** Reclaim only manifest-owned runs older than the caller's cutoff. Snapshot refs
 * are released after the old checkouts and their administrative metadata are gone. */
export async function recoverReviewWorktrees(
	options: RecoverReviewWorktreesOptions,
): Promise<RecoveredReviewWorktrees[]> {
	if (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0) {
		throw new Error("olderThanMs must be a finite, non-negative number.")
	}
	const requestedRoot = resolve(options.rootDir ?? DEFAULT_ROOT)
	if (!(await pathExists(requestedRoot))) return []
	const root = await realpath(requestedRoot)
	const cutoff = Date.now() - options.olderThanMs
	const recovered: RecoveredReviewWorktrees[] = []
	for (const directory of await readdir(root, { withFileTypes: true })) {
		if (!directory.isDirectory()) continue
		const runDir = join(root, directory.name)
		const manifestPath = join(runDir, MANIFEST)
		if (!(await pathExists(manifestPath))) continue
		const metadata = await stat(manifestPath)
		if (options.olderThanMs > 0 && metadata.mtimeMs > cutoff) continue
		const manifest = parseManifest(runDir, JSON.parse(await readFile(manifestPath, "utf8")))
		await serializeRepository(manifest.repository, async () => {
			const ownedPaths = await ownedReviewWorktreeRegistrations(manifest.repository, runDir, options.signal)
			const paths = new Set([...manifest.worktrees.map((entry) => entry.path), ...ownedPaths])
			const removedWorktrees: string[] = []
			for (const path of [...paths].reverse()) {
				if (await pathExists(path)) {
					const args = ["worktree", "remove", "--force", path] as const
					const result = await gitBytes(manifest.repository, args, {
						signal: options.signal,
						allowFailure: true,
					})
					if (result.exitCode !== 0 && (await pathExists(join(path, ".git")))) {
						throw gitResultError(args, result)
					}
					await rm(path, { recursive: true, force: true })
				}
				removedWorktrees.push(path)
			}
			await removeRunContentsExceptManifest(runDir)
			await gitText(manifest.repository, ["worktree", "prune"], { signal: options.signal })
			if (manifest.snapshotRef) {
				await cleanupReviewSnapshot({
					root: manifest.repository,
					ref: manifest.snapshotRef,
					expectedHeadSha: manifest.headSha,
					signal: options.signal,
				})
			}
			await rm(runDir, { recursive: true, force: true })
			recovered.push({
				runDir,
				repository: manifest.repository,
				removedWorktrees,
				...(manifest.snapshotRef ? { releasedSnapshotRef: manifest.snapshotRef } : {}),
			})
		})
	}
	return recovered
}

export const REVIEW_WORKTREE_TESTING = { MANIFEST, MANIFEST_VERSION, DEFAULT_ROOT }
