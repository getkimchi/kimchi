import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type RunOptions, type RunResult, runAgent, type ToolActivity } from "../agents/manager/agent-runner.js"
import type { LifetimeUsage } from "../agents/manager/usage.js"
import type { SubagentType, ThinkingLevel } from "../agents/personas/types.js"
import {
	createReconciliationSubmissionExtension,
	REVIEW_RECONCILIATION_TOOL,
} from "../review-panel/reconciliation-tool.js"
import type { SemanticReconciliation } from "../review-panel/types.js"
import { createReviewSubmitExtension } from "../review-submit/index.js"
import { DEFAULT_WRITER_LIMIT } from "../review-submit/store.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import type { ReviewCheckDefinition } from "./check-config.js"
import { ReviewCheckQueue } from "./checks.js"
import {
	createReviewExecutionController,
	type ReviewExecutionController,
	type ReviewExecutionPolicyOptions,
	reviewExecutionMode,
} from "./execution.js"
import { ReviewSessionStore } from "./sessions.js"
import { REVIEW_CHILD_TOOL_NAMES, registerReviewChildTools } from "./tools.js"
import type { ReviewWorktree, ReviewWorktreePool } from "./types.js"
import { createReviewWorktreePool } from "./worktrees.js"

export interface ReviewAgentOptions {
	model?: Model<Api>
	maxTurns?: number
	thinkingLevel?: ThinkingLevel
	inactivityTimeout?: number
	maxDuration?: number
	tokenBudget?: number
	sessionFile?: string
	sessionDir?: string
	onToolActivity?: (activity: ToolActivity) => void
	onTextDelta?: (delta: string, fullText: string) => void
	onSessionCreated?: RunOptions["onSessionCreated"]
	onTurnEnd?: (turnCount: number) => void
	onAssistantUsage?: (usage: LifetimeUsage) => void
	onCompaction?: RunOptions["onCompaction"]
}

export interface SpawnReviewerOptions {
	id: string
	prompt: string
	type?: SubagentType
	description?: string
	signal?: AbortSignal
	agent?: ReviewAgentOptions
}

export interface ReviewAgentResult extends RunResult {
	writer: string
	worktree: ReviewWorktree
	execution: ReviewExecutionController
	/** Structured output when a verifier uses submit_reconciliation. */
	reconciliation?: SemanticReconciliation
}

export type ReviewAgentSpawner = (request: {
	ctx: ExtensionContext
	type: SubagentType
	prompt: string
	options: RunOptions
}) => Promise<RunResult>

export interface ReviewRunnerOptions {
	ctx: ExtensionContext
	pi: ExtensionAPI
	target: ResolvedReviewTarget
	outputDir: string
	saveSessions?: boolean
	concurrency?: number
	writerLimit?: number
	rootDir?: string
	checkStatePath?: string
	checkDefinitions?: ReviewCheckDefinition[]
	/** Trusted coordinator policy. Unset mode uses only isInSandboxCluster(), never print mode. */
	executionPolicy?: ReviewExecutionPolicyOptions
	signal?: AbortSignal
	/** Test/integration seam; production uses the real agent runner. */
	spawnAgent?: ReviewAgentSpawner
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
	return present.length ? AbortSignal.any(present) : undefined
}

const defaultSpawner: ReviewAgentSpawner = ({ ctx, type, prompt, options }) => runAgent(ctx, type, prompt, options)

export class ReviewRunner {
	readonly checkQueue: ReviewCheckQueue
	private readonly active = new Map<string, AbortController>()
	private readonly activeRuns = new Map<string, Promise<ReviewAgentResult>>()
	private cleanupPromise?: Promise<void>
	private cleaned = false

	private constructor(
		private readonly options: ReviewRunnerOptions,
		readonly worktrees: ReviewWorktreePool,
		checkQueue: ReviewCheckQueue,
		private readonly sessions?: ReviewSessionStore,
	) {
		this.checkQueue = checkQueue
	}

	static async create(options: ReviewRunnerOptions): Promise<ReviewRunner> {
		let worktrees: ReviewWorktreePool | undefined
		let poolCreationStarted = false
		try {
			const writerLimit = options.writerLimit ?? DEFAULT_WRITER_LIMIT
			if (!Number.isSafeInteger(writerLimit) || writerLimit < 1 || writerLimit > 1000) {
				throw new Error("Review writer limit must be a decimal integer from 1 to 1000.")
			}
			const sessions = options.saveSessions ? await ReviewSessionStore.create(options.outputDir) : undefined
			poolCreationStarted = true
			worktrees = await createReviewWorktreePool({
				target: options.target,
				rootDir: options.rootDir,
				outputDir: options.outputDir,
				concurrency: options.concurrency,
				signal: options.signal,
			})
			const checkQueue = await ReviewCheckQueue.create({
				scope: options.target.scope,
				worktrees,
				outputDir: options.outputDir,
				statePath: options.checkStatePath,
				definitions: options.checkDefinitions,
				signal: options.signal,
			})
			return new ReviewRunner(options, worktrees, checkQueue, sessions)
		} catch (error) {
			if (worktrees) await worktrees.cleanup().catch(() => {})
			else if (!poolCreationStarted) await options.target.cleanup().catch(() => {})
			throw error
		}
	}

	get activeReviewers(): readonly string[] {
		return [...this.active.keys()]
	}

	cancelReviewer(id: string, reason?: unknown): boolean {
		const controller = this.active.get(id)
		if (!controller) return false
		controller.abort(reason)
		return true
	}

	cancelActiveReviewers(reason?: unknown): void {
		for (const controller of this.active.values()) controller.abort(reason)
	}

	spawnReviewer = (options: SpawnReviewerOptions): Promise<ReviewAgentResult> => {
		return this.spawnLeased(options)
	}

	spawnVerifier = (options: SpawnReviewerOptions): Promise<ReviewAgentResult> => {
		return this.spawnUnleased({ ...options, id: options.id || "verifier" }, "verifier")
	}

	private async spawnLeased(options: SpawnReviewerOptions): Promise<ReviewAgentResult> {
		if (this.cleaned) throw new Error("The review runner has been cleaned up.")
		this.assertAvailable(options.id)
		const controller = new AbortController()
		this.active.set(options.id, controller)
		const signal = combinedSignal(this.options.signal, options.signal, controller.signal)
		let lease: Awaited<ReturnType<ReviewWorktreePool["leaseReviewer"]>>
		try {
			lease = await this.worktrees.leaseReviewer(options.id, { signal })
		} catch (error) {
			this.active.delete(options.id)
			throw error
		}
		try {
			const run = this.spawnInWorktree(options, lease.worktree, signal)
			this.activeRuns.set(options.id, run)
			return await run
		} finally {
			this.active.delete(options.id)
			this.activeRuns.delete(options.id)
			lease.release()
		}
	}

	private async spawnUnleased(options: SpawnReviewerOptions, kind: "verifier"): Promise<ReviewAgentResult> {
		if (this.cleaned) throw new Error("The review runner has been cleaned up.")
		this.assertAvailable(options.id)
		const controller = new AbortController()
		this.active.set(options.id, controller)
		const signal = combinedSignal(this.options.signal, options.signal, controller.signal)
		try {
			const worktree = await this.worktrees.getWorktree(options.id, { kind, revision: "head" })
			const run = this.spawnInWorktree(options, worktree, signal, "verifier")
			this.activeRuns.set(options.id, run)
			return await run
		} finally {
			this.active.delete(options.id)
			this.activeRuns.delete(options.id)
		}
	}

	private assertAvailable(id: string): void {
		if (!/^[A-Za-z0-9_-]+$/.test(id))
			throw new Error("Reviewer writer IDs may contain only letters, digits, underscores, or hyphens.")
		if (this.active.has(id)) throw new Error(`Reviewer "${id}" is already active.`)
	}

	private async spawnInWorktree(
		options: SpawnReviewerOptions,
		worktree: ReviewWorktree,
		signal: AbortSignal | undefined,
		kind?: "verifier",
	): Promise<ReviewAgentResult> {
		const reconciliationBridge: { value?: SemanticReconciliation } = {}
		const session = this.sessions ? await this.sessions.allocate(options.id) : undefined
		const execution = createReviewExecutionController({
			mode: reviewExecutionMode(this.options.executionPolicy?.mode),
			worktree,
			executionGroup: resolve(this.options.outputDir),
			...(this.options.executionPolicy?.networkBoundary !== undefined
				? { networkBoundary: this.options.executionPolicy.networkBoundary }
				: {}),
			...(this.options.executionPolicy?.commandAuthorizer
				? { commandAuthorizer: this.options.executionPolicy.commandAuthorizer }
				: {}),
		})
		const writerContext = {
			writer: options.id,
			writerLimit: options.id === "final" ? DEFAULT_WRITER_LIMIT : (this.options.writerLimit ?? DEFAULT_WRITER_LIMIT),
			contextDir: this.options.target.scope.contextDir,
			outputDir: resolve(this.options.outputDir),
		}
		const spawnOptions: RunOptions = {
			...options.agent,
			...(session ?? {}),
			pi: this.options.pi,
			cwd: worktree.path,
			signal,
			isolated: true,
			inheritContext: false,
			isolateProjectConfiguration: true,
			reviewExecution: execution,
			additionalToolNames:
				kind === "verifier" ? [...REVIEW_CHILD_TOOL_NAMES, REVIEW_RECONCILIATION_TOOL] : REVIEW_CHILD_TOOL_NAMES,
			description: options.description ?? `Review writer ${options.id}`,
			extensionFactories: [
				createReviewSubmitExtension(writerContext),
				(pi) =>
					registerReviewChildTools(pi, {
						controller: execution,
						worktrees: this.worktrees,
						checks: this.checkQueue,
						writer: options.id,
					}),
				...(kind === "verifier" ? [createReconciliationSubmissionExtension(reconciliationBridge)] : []),
			],
		}
		let outcome: { result: RunResult } | { error: unknown }
		let privateFailure: { error: unknown } | undefined
		try {
			outcome = {
				result: await (this.options.spawnAgent ?? defaultSpawner)({
					ctx: this.options.ctx,
					type: options.type ?? "General-Purpose",
					prompt: options.prompt,
					options: spawnOptions,
				}),
			}
		} catch (error) {
			outcome = { error }
		} finally {
			if (session && this.sessions) {
				try {
					await this.sessions.makePrivate(session.sessionFile)
				} catch (error) {
					privateFailure = { error }
				}
			}
		}
		if ("error" in outcome) throw outcome.error
		if (privateFailure) throw privateFailure.error
		return {
			...outcome.result,
			writer: options.id,
			worktree,
			execution,
			...(reconciliationBridge.value === undefined ? {} : { reconciliation: reconciliationBridge.value }),
		}
	}

	beginWrapUp = (): void => {
		this.checkQueue.beginWrapUp()
	}

	cleanup = (): Promise<void> => {
		if (this.cleanupPromise) return this.cleanupPromise
		this.cleaned = true
		const operation = (async () => {
			this.cancelActiveReviewers(new Error("Review runner cleanup requested"))
			const checkClosure = this.checkQueue.close(new Error("Review runner cleanup requested"))
			await Promise.allSettled([...this.activeRuns.values()])
			await checkClosure
			await this.checkQueue.dispose()
			await this.worktrees.cleanup()
		})()
		this.cleanupPromise = operation.catch((error) => {
			this.cleanupPromise = undefined
			throw error
		})
		return this.cleanupPromise
	}
}
