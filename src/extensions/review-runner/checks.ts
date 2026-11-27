import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import { checkReviewDirectory } from "../review-submit/directory-safety.js"
import { gitBytes, gitText } from "../review-targets/git.js"
import type { ResolvedReviewScope } from "../review-targets/types.js"
import type { ReviewCheckDefinition } from "./check-config.js"
import { discoverPackageReviewChecks } from "./check-config.js"
import { REVIEW_ENVIRONMENT_SCHEMA_VERSION } from "./environment.js"
import {
	executeReviewCommand,
	isDirectInstallCommand,
	REVIEW_COMMAND_OUTPUT_LIMIT,
	type ReviewCommandRecord,
	type ReviewExecutionController,
} from "./execution.js"
import type { ReviewRevision, ReviewWorktree, ReviewWorktreePool } from "./types.js"

export const REVIEW_CHECK_STATE_VERSION = "review-check-state/v1"

export class ReviewCheckStateError extends Error {
	readonly code = "review_check_state_invalid"

	constructor(
		readonly statePath: string,
		detail: string,
		cause: unknown,
	) {
		super(
			`Could not load review check evidence at ${JSON.stringify(statePath)}: ${detail}. The review stopped to avoid discarding evidence. Repair the file using schema ${REVIEW_CHECK_STATE_VERSION}, or move it aside and rerun the review to rebuild check evidence.`,
			{ cause },
		)
		this.name = "ReviewCheckStateError"
	}
}

export type ReviewCheckDefinitionSource = "coordinator" | "reviewed-tree"

export interface ReviewExecutionProfile {
	toolchain: string
	dependencyDigest: string
	network: "offline" | "approved-online" | "sandbox"
	environment: {
		schemaVersion: typeof REVIEW_ENVIRONMENT_SCHEMA_VERSION
		requestedSpecDigest: string
		receiptDigest: string
		readiness: "ready" | "degraded" | "unready"
	}
}

export interface ReviewCheckResult extends ReviewCommandRecord {
	key: string
	definitionSource: ReviewCheckDefinitionSource
	id: string
	kind: ReviewCheckDefinition["kind"]
	requestedBy: string
	revision: ReviewRevision
	pinnedSha: string
	pinnedTree: string
	profile: ReviewExecutionProfile
	satisfiesBuild: boolean
	completedAt: string
}

export interface ReviewCheckRequest {
	id: string
	requestedBy: string
	controller: ReviewExecutionController
	toolCallId?: string
	revision?: ReviewRevision
	online?: boolean
	signal?: AbortSignal
}

export interface ReviewCheckQueueOptions {
	scope: ResolvedReviewScope
	worktrees: ReviewWorktreePool
	outputDir: string
	statePath?: string
	definitions?: ReviewCheckDefinition[]
	/** @internal Deterministic command seam for queue lifecycle tests. */
	executeCommand?: typeof executeReviewCommand
	signal?: AbortSignal
	now?: () => Date
}

interface SavedCheckState {
	schema_version: typeof REVIEW_CHECK_STATE_VERSION
	checks: ReviewCheckResult[]
}

function assertSavedResult(value: unknown): ReviewCheckResult {
	if (!value || typeof value !== "object") throw new Error("Review check state contains a non-object result.")
	const result = value as ReviewCheckResult
	for (const field of ["key", "id", "command", "cwd", "status", "output", "pinnedTree"] as const) {
		if (typeof result[field] !== "string") throw new Error(`Review check state result has no ${field}.`)
	}
	return {
		...result,
		definitionSource: result.definitionSource ?? "reviewed-tree",
		output: result.output.slice(-REVIEW_COMMAND_OUTPUT_LIMIT),
	}
}

async function loadState(path: string): Promise<SavedCheckState | undefined> {
	let contents: string
	try {
		contents = await readFile(path, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	try {
		const value = JSON.parse(contents) as Partial<SavedCheckState>
		if (value.schema_version !== REVIEW_CHECK_STATE_VERSION || !Array.isArray(value.checks)) {
			throw new Error("Review check state has an unsupported schema.")
		}
		return { schema_version: REVIEW_CHECK_STATE_VERSION, checks: value.checks.map(assertSavedResult) }
	} catch (error) {
		const detail =
			error instanceof SyntaxError
				? "the file does not contain valid JSON"
				: error instanceof Error
					? error.message
					: "the file has an invalid structure"
		throw new ReviewCheckStateError(path, detail, error)
	}
}

async function saveState(path: string, results: readonly ReviewCheckResult[]): Promise<void> {
	const checked = await checkReviewDirectory(dirname(path), { isDefault: false, create: true })
	if (checked.kind !== "ready")
		throw new Error(`Review check state directory ${dirname(path)} is unavailable or unsafe.`)
	const temporary = join(dirname(path), `.review-checks.${process.pid}.${randomUUID()}.tmp`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(temporary, "wx", 0o600)
		const state: SavedCheckState = {
			schema_version: REVIEW_CHECK_STATE_VERSION,
			checks: results.filter((result) => result.status !== "blocked" || result.approval !== "not-requested"),
		}
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await rename(temporary, path)
	} finally {
		await handle?.close().catch(() => {})
		await rm(temporary, { force: true }).catch(() => {})
	}
}

async function pinnedTree(repository: string, sha: string): Promise<string> {
	return (await gitText(repository, ["rev-parse", "--verify", "--end-of-options", `${sha}^{tree}`])).trim()
}

async function dependencyDigest(repository: string, sha: string, dependencies: readonly string[]): Promise<string> {
	const digest = createHash("sha256")
	for (const path of [...dependencies].sort()) {
		digest.update(path).update("\0")
		const contents = await gitBytes(repository, ["show", `${sha}:${path}`], { allowFailure: true })
		if (contents.exitCode === 0) digest.update(contents.stdout)
		else digest.update("<absent>")
		digest.update("\0")
	}
	return digest.digest("hex")
}

interface ReviewKey {
	key: string
	command: string
	cwd: string
	kind: ReviewCheckDefinition["kind"]
	revision: ReviewRevision
	pinnedSha: string
	pinnedTree: string
	profile: ReviewExecutionProfile
}

function syntheticResult(
	key: ReviewKey,
	request: ReviewCheckRequest,
	status: "blocked" | "cancelled",
	output: string,
	definitionSource: ReviewCheckDefinitionSource,
): ReviewCheckResult {
	return {
		key: key.key,
		definitionSource,
		id: request.id,
		kind: key.kind,
		requestedBy: request.requestedBy,
		revision: key.revision,
		pinnedSha: key.pinnedSha,
		pinnedTree: key.pinnedTree,
		profile: key.profile,
		command: key.command,
		cwd: key.cwd,
		intendedCheck: request.id,
		worktree: "<not-run>",
		status,
		elapsedMs: 0,
		output,
		network: "unenforced",
		approval: "not-requested",
		satisfiesBuild: false,
		completedAt: new Date().toISOString(),
	}
}

export class ReviewCheckQueue {
	private readonly definitions = new Map<string, ReviewCheckDefinition>()
	private readonly inFlight = new Map<string, Promise<ReviewCheckResult>>()
	private readonly requests = new Set<Promise<ReviewCheckResult>>()
	private readonly requestContext = new AsyncLocalStorage<true>()
	private readonly saved = new Map<string, ReviewCheckResult>()
	private readonly abort = new AbortController()
	private readonly definitionSource: ReviewCheckDefinitionSource
	private tail: Promise<void> = Promise.resolve()
	private wrappingUp = false
	private closed = false
	private detachSignal?: () => void

	private constructor(
		private readonly options: ReviewCheckQueueOptions,
		definitions: ReviewCheckDefinition[],
		savedResults: ReviewCheckResult[],
	) {
		this.definitionSource = options.definitions === undefined ? "reviewed-tree" : "coordinator"
		for (const definition of definitions) this.definitions.set(definition.id, definition)
		for (const result of savedResults) this.saved.set(result.key, result)
		if (options.signal) {
			const abort = () => this.abort.abort(options.signal?.reason)
			if (options.signal.aborted) abort()
			else options.signal.addEventListener("abort", abort, { once: true })
			this.detachSignal = () => options.signal?.removeEventListener("abort", abort)
		}
	}

	static async create(options: ReviewCheckQueueOptions): Promise<ReviewCheckQueue> {
		const statePath = options.statePath ?? join(options.outputDir, "state", "routine-checks.json")
		const [definitions, state] = await Promise.all([
			options.definitions === undefined
				? discoverPackageReviewChecks(options.scope.checkoutPath, options.scope.pinned.headSha)
				: Promise.resolve(options.definitions),
			loadState(statePath),
		])
		return new ReviewCheckQueue(options, definitions, state?.checks ?? [])
	}

	get results(): readonly ReviewCheckResult[] {
		return [...this.saved.values()]
	}

	get checks(): readonly ReviewCheckDefinition[] {
		return [...this.definitions.values()]
	}

	routineCommand(command: string, cwd: string): ReviewCheckDefinition | undefined {
		return this.checks.find((check) => check.command === command && resolve("/", check.cwd) === resolve("/", cwd))
	}

	beginWrapUp(): void {
		this.wrappingUp = true
	}

	cancel(reason?: unknown): void {
		this.abort.abort(reason)
	}

	/** Close coordinator-owned check evidence. Settling commands may finish
	 * within the caller's bounded cleanup; no result is persisted after closure. */
	close = async (reason?: unknown, timeoutMs?: number): Promise<void> => {
		if (this.closed) return this.idle()
		this.closed = true
		this.abort.abort(reason)
		if (timeoutMs !== undefined) {
			await raceWithTimeout(this.idle(), Math.max(0, timeoutMs), undefined)
			return
		}
		await this.idle()
	}

	async idle(): Promise<void> {
		this.rejectReentrantLifecycleCall("idle")
		while (this.requests.size > 0) await Promise.allSettled([...this.requests])
	}

	async dispose(): Promise<void> {
		this.rejectReentrantLifecycleCall("dispose")
		this.cancel(new Error("Review check queue disposed."))
		await this.idle()
		this.detachSignal?.()
		this.detachSignal = undefined
	}

	private rejectReentrantLifecycleCall(method: "idle" | "dispose"): void {
		if (this.requestContext.getStore()) {
			throw new Error(`ReviewCheckQueue.${method}() cannot be called from inside its own request callback.`)
		}
	}

	private async key(request: ReviewCheckRequest, worktree: ReviewWorktree | undefined): Promise<ReviewKey> {
		const definition = this.definitions.get(request.id)
		if (!definition) throw new Error(`Unknown review check ID "${request.id}".`)
		const revision = request.revision ?? "head"
		const pinnedSha = revision === "base" ? this.options.scope.pinned.baseSha : this.options.scope.pinned.headSha
		const network =
			request.controller.mode === "headless"
				? "sandbox"
				: request.online || isDirectInstallCommand(definition.command)
					? "approved-online"
					: "offline"
		const [tree, digest] = await Promise.all([
			pinnedTree(this.options.scope.checkoutPath, pinnedSha),
			dependencyDigest(this.options.scope.checkoutPath, pinnedSha, definition.dependencies),
		])
		const environment = worktree?.environment
		const profile: ReviewExecutionProfile = {
			toolchain: definition.toolchain,
			dependencyDigest: digest,
			network,
			environment: {
				schemaVersion: REVIEW_ENVIRONMENT_SCHEMA_VERSION,
				requestedSpecDigest: environment?.requestedSpecDigest ?? "unavailable",
				receiptDigest: environment?.receiptDigest ?? "unavailable",
				readiness: environment?.readiness ?? "unready",
			},
		}
		return {
			key: JSON.stringify({ pinnedTree: tree, command: definition.command, cwd: definition.cwd, profile }),
			command: definition.command,
			cwd: definition.cwd,
			kind: definition.kind,
			revision,
			pinnedSha,
			pinnedTree: tree,
			profile,
		}
	}

	private present(result: ReviewCheckResult, request: ReviewCheckRequest): ReviewCheckResult {
		const definition = this.definitions.get(request.id)
		if (!definition) throw new Error(`Unknown review check ID "${request.id}".`)
		const satisfiesBuild = result.status === "passed" && (definition.kind === "build" || definition.builds)
		if (
			result.id === definition.id &&
			result.kind === definition.kind &&
			result.definitionSource === this.definitionSource &&
			result.satisfiesBuild === satisfiesBuild
		) {
			return result
		}
		return {
			...result,
			definitionSource: this.definitionSource,
			id: definition.id,
			kind: definition.kind,
			satisfiesBuild,
		}
	}

	request = (request: ReviewCheckRequest): Promise<ReviewCheckResult> => {
		const pending = this.requestContext.run(true, () => this.performRequest(request))
		this.requests.add(pending)
		void pending.then(
			() => {
				this.requests.delete(pending)
			},
			() => {
				this.requests.delete(pending)
			},
		)
		return pending
	}

	private async performRequest(request: ReviewCheckRequest): Promise<ReviewCheckResult> {
		request.signal?.throwIfAborted()
		const revision = request.revision ?? "head"
		// The concrete ready worktree and its persisted receipt are inputs to the
		// key, and the exact same object is retained through execution below.
		const worktree = this.wrappingUp
			? this.options.worktrees.existingWorktree(`routine-${revision}`, { kind: "checks", revision })
			: await this.options.worktrees.getWorktree(`routine-${revision}`, { kind: "checks", revision })
		const key = await this.key(request, worktree)
		const denial = await request.controller.authorizeCommand(
			key.command,
			request.controller.executionFor(request.toolCallId) ?? { mode: "review-check-request" },
		)
		const deferredHardBlockReason = denial?.deferToReviewApproval ? denial.reason : undefined
		if (denial && !deferredHardBlockReason) {
			return syntheticResult(key, request, "blocked", denial.reason, this.definitionSource)
		}
		if (worktree) {
			const saved = this.saved.get(key.key)
			if (saved) return this.present(saved, request)
		}
		if (!worktree) {
			return syntheticResult(
				key,
				request,
				"blocked",
				"Review wrap-up has no existing ready routine worktree and receipt; no new work was started and no legacy evidence was reused.",
				this.definitionSource,
			)
		}
		if (request.controller.mode === "local" && request.online && !isDirectInstallCommand(key.command)) {
			const offline = await this.key({ ...request, online: false }, worktree)
			let offlineResult = this.saved.get(offline.key)
			const pending = this.inFlight.get(offline.key)
			if (!offlineResult && pending) offlineResult = await pending
			if (offlineResult?.status !== "failed") {
				return syntheticResult(
					key,
					request,
					"blocked",
					"An online rerun requires a failed offline execution of the same routine check and profile.",
					this.definitionSource,
				)
			}
		}
		if (this.wrappingUp) {
			return syntheticResult(
				key,
				request,
				"blocked",
				"Review wrap-up reuses saved checks and does not start new work.",
				this.definitionSource,
			)
		}
		if (this.abort.signal.aborted) {
			return syntheticResult(
				key,
				request,
				"cancelled",
				"The review check queue was cancelled before this check ran.",
				this.definitionSource,
			)
		}
		const existing = this.inFlight.get(key.key)
		if (existing) return this.present(await existing, request)
		const execution = this.tail
			.catch(() => {})
			.then(() => this.execute(key, request, worktree, deferredHardBlockReason))
		this.inFlight.set(key.key, execution)
		this.tail = execution.then(
			() => undefined,
			() => undefined,
		)
		try {
			return this.present(await execution, request)
		} finally {
			if (this.inFlight.get(key.key) === execution) this.inFlight.delete(key.key)
		}
	}

	private async execute(
		key: ReviewKey,
		request: ReviewCheckRequest,
		worktree: ReviewWorktree,
		deferredHardBlockReason?: string,
	): Promise<ReviewCheckResult> {
		const definition = this.definitions.get(request.id)
		if (!definition) throw new Error(`Unknown review check ID "${request.id}".`)
		if (this.wrappingUp) {
			return syntheticResult(
				key,
				request,
				"blocked",
				"Review wrap-up began before this queued check started; it was not run.",
				this.definitionSource,
			)
		}
		if (this.abort.signal.aborted) {
			return syntheticResult(
				key,
				request,
				"cancelled",
				"The review check queue was cancelled before this check ran.",
				this.definitionSource,
			)
		}
		const record = await (this.options.executeCommand ?? executeReviewCommand)(request.controller, {
			command: key.command,
			cwd: resolve(worktree.path, definition.cwd),
			intendedCheck: request.id,
			worktree,
			online: request.online,
			toolCallId: request.toolCallId,
			authorizationAlreadyChecked: true,
			...(deferredHardBlockReason ? { deferredHardBlockReason } : {}),
			signal: this.abort.signal,
		})
		const result: ReviewCheckResult = {
			...record,
			key: key.key,
			definitionSource: this.definitionSource,
			id: request.id,
			kind: definition.kind,
			requestedBy: request.requestedBy,
			revision: key.revision,
			pinnedSha: key.pinnedSha,
			pinnedTree: key.pinnedTree,
			profile: key.profile,
			satisfiesBuild: record.status === "passed" && (definition.kind === "build" || definition.builds),
			completedAt: (this.options.now?.() ?? new Date()).toISOString(),
		}
		if (this.closed) return this.present(result, request)
		this.saved.set(key.key, result)
		await saveState(
			this.options.statePath ?? join(this.options.outputDir, "state", "routine-checks.json"),
			this.results,
		)
		return this.present(result, request)
	}
}
