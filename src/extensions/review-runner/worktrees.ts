import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
	currentReviewHost,
	currentReviewOwnerIdentity,
	reviewProcessStartIdentity,
} from "../review-command/owner-identity.js"
import { reviewStateArray, updateReviewJson } from "../review-panel/output.js"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import { gitBytes, gitResultError, gitText, repositoryRoot } from "../review-targets/git.js"
import { cleanupReviewSnapshot } from "../review-targets/resolve.js"
import {
	emptyReviewEnvironmentSettings,
	prepareReviewEnvironment,
	REVIEW_ENVIRONMENT_OUTPUT_LIMIT,
	REVIEW_ENVIRONMENT_TOTAL_TIMEOUT_MS,
	REVIEW_ENVIRONMENTS_STATE_VERSION,
	type ReviewEnvironmentBoundary,
	type ReviewEnvironmentCommand,
	type ReviewEnvironmentExecutionResult,
	type ReviewEnvironmentGap,
	type ReviewEnvironmentPlan,
	type ReviewEnvironmentReceipt,
	resolveReviewEnvironmentPlan,
	reviewEnvironmentReceiptDigest,
} from "./environment.js"
import {
	createReviewExecutionController,
	executeReviewCommand,
	type ReviewExecutionMode,
	reviewExecutionMode,
} from "./execution.js"
import { captureReviewWorktreeGitAdmin } from "./git-admin.js"
import { detectReviewNetworkBoundary, type ReviewNetworkBoundary } from "./network-boundary.js"
import { PreparationContainmentError, withPreparationDescendantCleanup } from "./preparation-process.js"
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
	gitAdminDir?: string
	status: "pending" | "ready" | "unready"
}

interface WorktreeManifest {
	schema_version: typeof MANIFEST_VERSION
	repository: string
	contextDir: string
	outputDir: string
	baseSha: string
	headSha: string
	snapshotRef?: string
	ownerPid?: number
	ownerHost?: string
	ownerStart?: string
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

async function ownerIsLive(manifest: WorktreeManifest): Promise<boolean> {
	if (manifest.ownerPid === undefined && manifest.ownerHost === undefined && manifest.ownerStart === undefined) {
		// Unknown ownership is not proof that reclamation is safe.
		return true
	}
	if (
		typeof manifest.ownerPid !== "number" ||
		!Number.isSafeInteger(manifest.ownerPid) ||
		manifest.ownerPid < 1 ||
		typeof manifest.ownerHost !== "string" ||
		manifest.ownerHost.length === 0 ||
		typeof manifest.ownerStart !== "string" ||
		manifest.ownerStart.length === 0
	) {
		throw new Error("Reviewer worktree manifest has an unsafe owner identity.")
	}
	// Hostnames can change with the network. A foreign or unverifiable owner
	// belongs to another review namespace and must never be reclaimed locally.
	if (manifest.ownerHost !== currentReviewHost()) return true
	try {
		process.kill(manifest.ownerPid, 0)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
		return true
	}
	try {
		return (await reviewProcessStartIdentity(manifest.ownerPid)) === manifest.ownerStart
	} catch {
		// Unknown liveness preserves another root; it never guesses from PID reuse.
		return true
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
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
	const handle = await open(temporary, "wx", 0o600)
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
		await handle.sync()
	} finally {
		await handle.close()
	}
	try {
		if (exclusive) await link(temporary, path)
		else await rename(temporary, path)
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

async function canonicalPreparationCwd(worktreePath: string, requestedCwd: string): Promise<string> {
	const canonicalRoot = await realpath(worktreePath)
	let current = canonicalRoot
	for (const part of requestedCwd.split(/[\\/]/).filter((part) => part && part !== ".")) {
		current = join(current, part)
		const metadata = await lstat(current)
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			throw new Error(`Environment preparation cwd ${requestedCwd} traverses a symbolic link or non-directory.`)
		}
	}
	const canonical = await realpath(current)
	if (!contained(canonicalRoot, canonical)) {
		throw new Error(`Environment preparation cwd ${requestedCwd} escapes its assigned worktree.`)
	}
	return canonical
}

class WorktreePool implements ReviewWorktreePool {
	private readonly worktrees = new Map<string, ReviewWorktree>()
	private readonly entries = new Map<string, WorktreeManifestEntry>()
	private readonly pending = new Map<string, Promise<ReviewWorktree>>()
	private readonly receipts = new Map<string, ReviewEnvironmentReceipt>()
	private receiptTail: Promise<void> = Promise.resolve()
	private readonly waiters: Array<{
		id: string
		signal?: AbortSignal
		onAbort?: () => void
		settled?: boolean
		resolve: (lease: ReviewWorktreeLease) => void
		reject: (error: unknown) => void
	}> = []
	private activeLeases = 0
	private cleaned = false
	private cleanupPromise?: Promise<void>
	private readonly preparationAbort = new AbortController()
	private readonly preparationSignal: AbortSignal

	constructor(
		readonly scope: ReviewWorktreeOptions["target"]["scope"],
		readonly runDir: string,
		private readonly repository: string,
		private readonly concurrency: number,
		private readonly releaseTarget: () => Promise<void>,
		private readonly manifest: WorktreeManifest,
		private readonly environmentPlan: ReviewEnvironmentPlan,
		private readonly executionMode: ReviewExecutionMode,
		private readonly environmentBoundary: ReviewEnvironmentBoundary,
		private readonly networkBoundary: ReviewNetworkBoundary | undefined,
		private readonly signal: AbortSignal | undefined,
		private readonly preparationTimeoutMs: number,
		private readonly crashPoint?: ReviewWorktreeOptions["worktreeCrashPoint"],
	) {
		this.preparationSignal = this.signal
			? AbortSignal.any([this.signal, this.preparationAbort.signal])
			: this.preparationAbort.signal
	}

	get environmentReceipts(): readonly ReviewEnvironmentReceipt[] {
		return [...this.receipts.values()]
	}

	get environmentGaps(): readonly ReviewEnvironmentGap[] {
		const gaps = new Map<string, ReviewEnvironmentGap>()
		for (const gap of [...this.environmentPlan.gaps, ...this.environmentReceipts.flatMap((receipt) => receipt.gaps)]) {
			gaps.set(JSON.stringify([gap.kind, gap.name, gap.note]), gap)
		}
		return [...gaps.values()]
	}

	private environmentsPath(): string {
		return join(this.manifest.outputDir, "state", "environments.json")
	}

	async loadEnvironmentReceipts(): Promise<void> {
		let current: unknown
		try {
			current = JSON.parse(await readFile(this.environmentsPath(), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		this.receipts.clear()
		for (const value of reviewStateArray(current, REVIEW_ENVIRONMENTS_STATE_VERSION, "environments")) {
			if (value && typeof value === "object" && typeof (value as ReviewEnvironmentReceipt).worktreeId === "string") {
				const receipt = value as ReviewEnvironmentReceipt
				this.receipts.set(receipt.worktreeId, receipt)
			}
		}
	}

	private async persistReceipt(key: string, receipt: ReviewEnvironmentReceipt): Promise<void> {
		this.receipts.set(key, receipt)
		const operation = this.receiptTail
			.catch(() => {})
			.then(() =>
				updateReviewJson(this.environmentsPath(), (current) => {
					const merged = new Map<string, ReviewEnvironmentReceipt>()
					for (const previous of reviewStateArray(current, REVIEW_ENVIRONMENTS_STATE_VERSION, "environments")) {
						if (
							previous &&
							typeof previous === "object" &&
							typeof (previous as ReviewEnvironmentReceipt).worktreeId === "string"
						) {
							const existing = previous as ReviewEnvironmentReceipt
							merged.set(existing.worktreeId, existing)
						}
					}
					for (const currentReceipt of this.receipts.values()) merged.set(currentReceipt.worktreeId, currentReceipt)
					return {
						schema_version: REVIEW_ENVIRONMENTS_STATE_VERSION,
						environments: [...merged.values()],
					}
				}),
			)
		this.receiptTail = operation
		return operation
	}

	async getWorktree(
		id: string,
		options: { kind?: ReviewCheckoutKind; revision?: ReviewRevision; signal?: AbortSignal } = {},
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
		const creation = this.createWorktree(key, id, kind, revision, options.signal).finally(() =>
			this.pending.delete(key),
		)
		this.pending.set(key, creation)
		return creation
	}

	existingWorktree(
		id: string,
		options: { kind?: ReviewCheckoutKind; revision?: ReviewRevision } = {},
	): ReviewWorktree | undefined {
		return this.worktrees.get(`${options.kind ?? "reviewer"}:${options.revision ?? "head"}:${id}`)
	}

	private async createWorktree(
		key: string,
		id: string,
		kind: ReviewCheckoutKind,
		revision: ReviewRevision,
		perRunSignal?: AbortSignal,
	): Promise<ReviewWorktree> {
		const preparationSignal = perRunSignal
			? AbortSignal.any([this.preparationSignal, perRunSignal])
			: this.preparationSignal
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
		const preparationDeadline = Date.now() + this.preparationTimeoutMs
		try {
			const { worktreeMetadata, commonGitDir } = await serializeRepository(this.repository, async () => {
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
				const gitAdminDir = await captureReviewWorktreeGitAdmin(path, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))
				entry.gitAdminDir = gitAdminDir
				const worktreeMetadata = { ...worktreeBase, gitAdminDir }
				const commonGitDir = await realpath(
					await gitText(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
						signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
					}),
				)
				return { worktreeMetadata, commonGitDir }
			})
			// Setup/probes are per-worktree and run outside the repository lock.
			// Only Git registration and manifest transitions serialize.
			const prepared = await prepareReviewEnvironment({
				worktreeId: key,
				worktree: worktreeMetadata,
				privateEnv: worktreeEnvironment(worktreeMetadata),
				plan: this.environmentPlan,
				boundary: this.environmentBoundary,
				forbiddenCachePaths: [
					this.repository,
					this.manifest.contextDir,
					this.manifest.outputDir,
					this.runDir,
					commonGitDir,
					worktreeBase.path,
					worktreeBase.scratchDir,
					worktreeBase.buildDir,
					worktreeBase.cacheDir,
					worktreeBase.homeDir,
				],
				signal: preparationSignal,
				execute: (current, command) =>
					this.executeEnvironmentCommand(current, command, preparationDeadline, preparationSignal),
				resetToIsolated: (current) => this.resetToIsolated(current),
			})
			const worktree = prepared.worktree
			if (
				this.environmentPlan.requestedSpec.readOnlyCaches.length === 0 &&
				this.environmentPlan.requestedSpec.privateDirs.length === 0 &&
				Object.keys(this.environmentPlan.requestedSpec.env).length === 0 &&
				this.environmentPlan.requestedSpec.toolchain === undefined &&
				this.environmentPlan.requestedSpec.setup.length === 0 &&
				this.environmentPlan.requestedSpec.probes.length === 0
			) {
				worktree.env = worktreeEnvironment(worktreeMetadata)
				if (this.executionMode === "headless" && worktree.environment) {
					worktree.environment.environment = worktree.env
					worktree.environment.receiptDigest = reviewEnvironmentReceiptDigest(worktree.environment)
				}
			}
			const receipt = worktree.environment ?? prepared.receipt
			await this.persistReceipt(key, receipt)
			return await serializeRepository(this.repository, async () => {
				entry.status = receipt.readiness === "unready" ? "unready" : "ready"
				this.entries.set(key, entry)
				this.manifest.worktrees = [...this.entries.values()]
				this.manifest.updatedAt = Date.now()
				await atomicJson(join(this.runDir, MANIFEST), this.manifest)
				if (receipt.readiness === "unready") {
					throw new Error(`Review environment ${key} is unready; see state/environments.json for its receipt and gaps.`)
				}
				this.worktrees.set(key, worktree)
				return worktree
			})
		} catch (error) {
			await serializeRepository(this.repository, async () => {
				await rm(path, { recursive: true, force: true }).catch(() => {})
				await gitText(this.repository, ["worktree", "prune"], {
					signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
				}).catch(() => {})
			}).catch(() => {})
			throw error
		}
	}

	private async executeEnvironmentCommand(
		worktree: ReviewWorktree,
		command: ReviewEnvironmentCommand,
		preparationDeadline: number,
		preparationSignal: AbortSignal,
	): Promise<ReviewEnvironmentExecutionResult> {
		const remainingMs = preparationDeadline - Date.now()
		if (remainingMs <= 0) {
			return {
				status: "cancelled",
				elapsedMs: 0,
				output: `Environment preparation exceeded its overall ${this.preparationTimeoutMs} ms limit.`,
				timedOut: true,
			}
		}
		const commandTimeoutMs = Math.min(command.timeoutMs, remainingMs)
		const controller = createReviewExecutionController({
			mode: this.executionMode,
			worktree,
			executionGroup: resolve(this.manifest.outputDir),
			networkBoundary: this.networkBoundary ?? null,
		})
		const timeout = new AbortController()
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			timeout.abort(new Error(`Environment command exceeded its bounded ${commandTimeoutMs} ms timeout.`))
		}, commandTimeoutMs)
		timer.unref()
		const signal = AbortSignal.any([preparationSignal, timeout.signal])
		const startedAt = Date.now()
		const shellCommand = command.argv.map((argument) => `'${argument.replace(/'/g, `'\\''`)}'`).join(" ")
		try {
			const cwd = await canonicalPreparationCwd(worktree.path, command.cwd)
			const record = await withPreparationDescendantCleanup({
				pidFile: join(worktree.scratchDir, `.preparation-${randomUUID()}.pid`),
				signal,
				execute: ({ pidFile, signal: executionSignal, preparationId }) =>
					executeReviewCommand(controller, {
						command: shellCommand,
						cwd,
						intendedCheck: "trusted environment preparation",
						worktree,
						offlineOnly: true,
						authorizationAlreadyChecked: true,
						signal: executionSignal,
						preparationPidFile: pidFile,
						preparationId,
						outputLimit: REVIEW_ENVIRONMENT_OUTPUT_LIMIT,
					}),
			})
			return {
				status: record.status,
				...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
				elapsedMs: record.elapsedMs,
				output: record.output,
				timedOut,
			}
		} catch (error) {
			return {
				status: signal.aborted ? "cancelled" : "failed",
				elapsedMs: Date.now() - startedAt,
				output: error instanceof Error ? error.message : String(error),
				timedOut,
				...(error instanceof PreparationContainmentError
					? {
							gap: {
								kind: "preparation_containment",
								name: command.argv[0] ?? "setup",
								note: error.message,
							},
						}
					: {}),
			}
		} finally {
			clearTimeout(timer)
		}
	}

	private async resetToIsolated(
		worktree: ReviewWorktree,
	): Promise<{ worktree: Omit<ReviewWorktree, "env">; privateEnv: Record<string, string> }> {
		const fresh = await serializeRepository(this.repository, async () => {
			await gitText(this.repository, ["worktree", "remove", "--force", worktree.path], {
				signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
			}).catch(async () => {
				await rm(worktree.path, { recursive: true, force: true })
			})
			await gitText(this.repository, ["worktree", "prune"], {
				signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
			}).catch(() => {})

			const directory = join(
				this.runDir,
				`${safeName(`${worktree.kind}:${worktree.revision}:${worktree.id}`)}-fallback-${randomUUID()}`,
			)
			const path = join(directory, "checkout")
			const base = {
				id: worktree.id,
				kind: worktree.kind,
				revision: worktree.revision,
				path,
				pinnedSha: worktree.pinnedSha,
				scratchDir: join(directory, "scratch"),
				buildDir: join(directory, "build"),
				cacheDir: join(directory, "cache"),
				homeDir: join(directory, "home"),
			}
			await mkdir(directory, { recursive: true, mode: 0o700 })
			await Promise.all(
				[base.scratchDir, base.buildDir, base.cacheDir, base.homeDir].map((part) =>
					mkdir(part, { recursive: true, mode: 0o700 }),
				),
			)
			const entry = this.entries.get(`${worktree.kind}:${worktree.revision}:${worktree.id}`)
			if (entry) {
				entry.path = path
				entry.gitAdminDir = undefined
				entry.status = "pending"
				this.manifest.worktrees = [...this.entries.values()]
				this.manifest.updatedAt = Date.now()
				await atomicJson(join(this.runDir, MANIFEST), this.manifest)
			}
			await gitText(this.repository, ["worktree", "add", "--detach", path, worktree.pinnedSha], {
				signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
			})
			const gitAdminDir = await captureReviewWorktreeGitAdmin(path, AbortSignal.timeout(CLEANUP_TIMEOUT_MS))
			if (entry) entry.gitAdminDir = gitAdminDir
			return { ...base, gitAdminDir }
		})
		return { worktree: fresh, privateEnv: worktreeEnvironment(fresh) }
	}

	async leaseReviewer(id: string, options: { signal?: AbortSignal } = {}): Promise<ReviewWorktreeLease> {
		if (this.cleaned) throw new Error("Reviewer worktrees have already been cleaned up.")
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Reviewer worktree lease was cancelled.")
		if (this.cleaned) throw new Error("Reviewer worktrees have already been cleaned up.")
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Reviewer worktree lease was cancelled.")
		return new Promise<ReviewWorktreeLease>((resolveLease, reject) => {
			const waiter: (typeof this.waiters)[number] = {
				id,
				signal: options.signal,
				resolve: resolveLease,
				reject,
			}
			if (options.signal) {
				waiter.onAbort = () => {
					if (waiter.settled) return
					waiter.settled = true
					options.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}))
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
			if (!waiter) continue
			if (waiter.signal?.aborted) {
				waiter.onAbort?.()
				continue
			}
			this.activeLeases += 1
			void this.getWorktree(waiter.id, { ...(waiter.signal ? { signal: waiter.signal } : {}) }).then(
				(worktree) => {
					if (this.cleaned || waiter.settled || waiter.signal?.aborted) {
						this.activeLeases = Math.max(0, this.activeLeases - 1)
						if (!waiter.settled) {
							waiter.settled = true
							waiter.reject(new Error("Reviewer worktree lease was cleaned up before becoming available."))
						}
						this.drainLeases()
						return
					}
					let released = false
					waiter.settled = true
					waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}))
					waiter.resolve({
						worktree,
						release: () => {
							if (released) return
							released = true
							this.activeLeases = Math.max(0, this.activeLeases - 1)
							this.drainLeases()
						},
					})
					this.drainLeases()
				},
				(error) => {
					this.activeLeases = Math.max(0, this.activeLeases - 1)
					if (!waiter.settled) {
						waiter.settled = true
						waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}))
						waiter.reject(error)
					}
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
		this.preparationAbort.abort(new Error("Reviewer worktree cleanup requested."))
		const operation = (async () => {
			await Promise.allSettled([...this.pending.values()])
			await serializeRepository(this.repository, async () => {
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
					throw new AggregateError(
						failures,
						"Could not remove every reviewer worktree; the snapshot ref remains pinned.",
					)
				}
				await removeRunContentsExceptManifest(this.runDir)
				await gitText(this.repository, ["worktree", "prune"], { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) })
				await this.releaseTarget()
				await rm(this.runDir, { recursive: true, force: true })
			})
		})()
		this.cleanupPromise = operation.catch((error) => {
			this.cleanupPromise = undefined
			throw error
		})
		return this.cleanupPromise
	}
}

function executionEnvironmentBoundary(
	mode: ReviewExecutionMode,
	boundary: ReviewNetworkBoundary | undefined,
): ReviewEnvironmentBoundary {
	if (mode === "headless") {
		return {
			kind: "outer-sandbox",
			capabilities: { networkOff: false, filesystemConfinement: false, readOnlyMounts: false },
		}
	}
	if (!boundary) {
		return {
			kind: "unavailable",
			capabilities: { networkOff: false, filesystemConfinement: false, readOnlyMounts: false },
		}
	}
	const capabilities =
		boundary.kind === "unshare-net"
			? { networkOff: true, filesystemConfinement: false, readOnlyMounts: false }
			: { networkOff: true, filesystemConfinement: true, readOnlyMounts: true }
	return {
		kind: boundary.kind,
		capabilities: {
			...capabilities,
			...(boundary.preparationPidNamespace === undefined
				? {}
				: { preparationPidNamespace: boundary.preparationPidNamespace }),
		},
	}
}

export async function createReviewWorktreePool(options: ReviewWorktreeOptions): Promise<ReviewWorktreePool> {
	let runDir: string | undefined
	try {
		if (!Number.isSafeInteger(options.concurrency ?? 1) || (options.concurrency ?? 1) < 1) {
			throw new Error("Reviewer worktree concurrency must be a positive integer.")
		}
		if (
			options.preparationTimeoutMs !== undefined &&
			(!Number.isSafeInteger(options.preparationTimeoutMs) ||
				options.preparationTimeoutMs < 1 ||
				options.preparationTimeoutMs > REVIEW_ENVIRONMENT_TOTAL_TIMEOUT_MS)
		) {
			throw new Error(`Preparation timeout must be from 1 to ${REVIEW_ENVIRONMENT_TOTAL_TIMEOUT_MS} ms.`)
		}
		options.signal?.throwIfAborted()
		const repository = await repositoryRoot(options.target.scope.checkoutPath, options.signal)
		const rootParent = await checkedDirectory(resolve(options.rootDir ?? DEFAULT_ROOT))
		const contextDir = resolve(options.target.scope.contextDir)
		const outputDir = resolve(options.outputDir)
		assertOutside(repository, contextDir, outputDir, rootParent)
		runDir = join(rootParent, `${safeName(basename(repository))}-${randomUUID()}`)
		await mkdir(runDir, { mode: 0o700 })
		const scope = options.target.scope
		const owner = await currentReviewOwnerIdentity()
		const manifest: WorktreeManifest = {
			schema_version: MANIFEST_VERSION,
			repository,
			contextDir,
			outputDir,
			baseSha: scope.pinned.baseSha,
			headSha: scope.pinned.headSha,
			...(scope.pinned.snapshotRef ? { snapshotRef: scope.pinned.snapshotRef } : {}),
			ownerPid: process.pid,
			ownerHost: owner.hostname,
			ownerStart: owner.startIdentity,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			worktrees: [],
		}
		await atomicJson(join(runDir, MANIFEST), manifest, true)
		const environmentPlan = await resolveReviewEnvironmentPlan(
			options.environment ?? emptyReviewEnvironmentSettings(),
			repository,
			options.environmentGaps,
		)
		const executionMode = reviewExecutionMode(options.executionPolicy?.mode)
		const networkBoundary =
			executionMode === "headless"
				? undefined
				: options.executionPolicy?.networkBoundary !== undefined
					? (options.executionPolicy.networkBoundary ?? undefined)
					: await detectReviewNetworkBoundary()
		const pool = new WorktreePool(
			scope,
			runDir,
			repository,
			options.concurrency ?? 1,
			options.target.cleanup,
			manifest,
			environmentPlan,
			executionMode,
			executionEnvironmentBoundary(executionMode, networkBoundary),
			networkBoundary,
			options.signal,
			options.preparationTimeoutMs ?? REVIEW_ENVIRONMENT_TOTAL_TIMEOUT_MS,
			options.worktreeCrashPoint,
		)
		await pool.loadEnvironmentReceipts()
		return pool
	} catch (error) {
		if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => {})
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
		try {
			const manifestPath = join(runDir, MANIFEST)
			if (!(await pathExists(manifestPath))) continue
			const metadata = await stat(manifestPath)
			if (options.olderThanMs > 0 && metadata.mtimeMs > cutoff) continue
			const manifest = parseManifest(runDir, JSON.parse(await readFile(manifestPath, "utf8")))
			if (await ownerIsLive(manifest)) continue
			await serializeRepository(manifest.repository, async () => {
				if (!(await pathExists(manifest.repository))) {
					await rm(runDir, { recursive: true, force: true })
					recovered.push({
						runDir,
						repository: manifest.repository,
						removedWorktrees: manifest.worktrees.map((entry) => entry.path),
					})
					return
				}
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
		} catch (error) {
			options.signal?.throwIfAborted()
			console.warn(
				`Could not recover reviewer worktree run ${runDir}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return recovered
}

export const REVIEW_WORKTREE_TESTING = { MANIFEST, MANIFEST_VERSION, DEFAULT_ROOT }
