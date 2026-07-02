import { randomUUID } from "node:crypto"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type {
	AgentOutcome,
	AgentRecord,
	AgentReport,
	AgentResumeAttempt,
	AgentTaskRef,
	AgentVisibility,
	IsolationMode,
	SubagentType,
	ThinkingLevel,
} from "../personas/types.js"
import { FERMENT_WORKER_BUDGETS } from "../worker-budget-policy.js"
import type { WorkerReportSubmission } from "../worker-report.js"
import {
	MIN_FINALIZE_TOKEN_BUDGET,
	MIN_TOKEN_BUDGET,
	type ToolActivity,
	resumeAgent,
	runAgent,
} from "./agent-runner.js"
import { type LifetimeUsage, addUsage } from "./usage.js"

export type OnAgentComplete = (record: AgentRecord) => void
export type OnAgentStart = (record: AgentRecord) => void
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_CONTINUATION_RESUMES = 2
const DEFAULT_MAX_REPORT_FINALIZERS = 1
const REPORT_FINALIZATION_LIMITS = { maxTurns: 2, maxDuration: 30, tokenBudget: 8192 } as const

interface SpawnArgs {
	pi: ExtensionAPI
	ctx: ExtensionContext
	type: SubagentType
	prompt: string
	options: SpawnOptions
}

interface SpawnOptions {
	description: string
	visibility?: AgentVisibility
	model?: Model<Api>
	maxTurns?: number
	isolated?: boolean
	inheritContext?: boolean
	thinkingLevel?: ThinkingLevel
	isBackground?: boolean
	/**
	 * Skip the maxConcurrent queue check for this spawn — start immediately even
	 * if the configured concurrency limit would otherwise queue it.
	 */
	bypassQueue?: boolean
	isolation?: IsolationMode
	sessionFile?: string
	sessionDir?: string
	signal?: AbortSignal
	tokenBudget?: number
	taskRef?: AgentTaskRef
	inactivityTimeout?: number
	maxDuration?: number
	onToolActivity?: (activity: ToolActivity) => void
	onTextDelta?: (delta: string, fullText: string) => void
	onSessionCreated?: (session: AgentSession) => void
	onTurnEnd?: (turnCount: number) => void
	onAssistantUsage?: (usage: LifetimeUsage) => void
	onCompaction?: (info: CompactionInfo) => void
}

function formatTaskRef(ref: AgentTaskRef): string {
	return JSON.stringify(ref)
}

function cumulativeTokenBudget(taskRef: AgentTaskRef): number {
	return FERMENT_WORKER_BUDGETS[taskRef.budget_tier ?? "standard"].cumulativeTokenBudget
}

function applyLinkedWorkerLimits(options: SpawnOptions): SpawnOptions {
	if (!options.taskRef) return options
	const budget = FERMENT_WORKER_BUDGETS[options.taskRef.budget_tier ?? "standard"]
	return {
		...options,
		maxTurns: Math.min(options.maxTurns ?? budget.maxTurns, budget.maxTurns),
		maxDuration: Math.min(options.maxDuration ?? budget.maxDuration, budget.maxDuration),
		tokenBudget: Math.min(options.tokenBudget ?? budget.tokenBudget, budget.tokenBudget),
	}
}

function withAgentReportProtocol(prompt: string, taskRef: AgentTaskRef | undefined): string {
	if (!taskRef) return prompt
	return `You are a Ferment-linked worker Agent.

Task ref: ${formatTaskRef(taskRef)}

Call submit_agent_report alone as your final action. The host binds the report to this worker and ends the run after accepting it, so finish all intended edits and verification before calling it. Report factual progress only:
- status "completed" when the assigned work is complete
- status "partial" when useful work remains
- status "blocked" when external input or an unresolved blocker prevents progress
- steps_completed: concrete steps you finished
- remaining_steps: concrete work still left, or [] when complete
- blockers: blockers only, not generic uncertainty

If you receive a budget warning, use the remaining headroom deliberately. If there is enough room to safely finish and verify the current unit, do that first, then call submit_agent_report. If the budget is nearly exhausted or uncertain, stop work and submit your current state immediately.

${prompt}`
}

function reportFinalizationPrompt(taskRef: AgentTaskRef): string {
	return `You are finalizing the report for this Ferment-linked worker attempt.

Task ref: ${formatTaskRef(taskRef)}

Do not perform more task work, edit files, explore, or run verification. Based only on the work already present in this session, call submit_agent_report alone as your next and final action. Report factual progress. Use status "completed" only if the assigned work is complete; otherwise use "partial" or "blocked", with concrete remaining_steps or blockers.`
}

export class AgentManager {
	private agents = new Map<string, AgentRecord>()
	private runtimeCleanups = new WeakMap<AgentRecord, () => void>()
	private activeResumePromises = new WeakMap<AgentRecord, Promise<unknown>>()
	private cleanupInterval: ReturnType<typeof setInterval>
	private onComplete?: OnAgentComplete
	private onStart?: OnAgentStart
	private onCompact?: OnAgentCompact
	private maxConcurrent: number

	private queue: { id: string; args: SpawnArgs }[] = []
	private runningBackground = 0

	constructor(
		onComplete?: OnAgentComplete,
		maxConcurrent = DEFAULT_MAX_CONCURRENT,
		onStart?: OnAgentStart,
		onCompact?: OnAgentCompact,
	) {
		this.onComplete = onComplete
		this.onStart = onStart
		this.onCompact = onCompact
		this.maxConcurrent = maxConcurrent
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000)
	}

	setMaxConcurrent(n: number) {
		this.maxConcurrent = Math.max(1, n)
		this.drainQueue()
	}

	getMaxConcurrent(): number {
		return this.maxConcurrent
	}

	spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
		const effectiveOptions = applyLinkedWorkerLimits(options)
		const id = randomUUID().slice(0, 17)
		const abortController = new AbortController()
		const record: AgentRecord = {
			id,
			type,
			description: effectiveOptions.description,
			visibility: effectiveOptions.visibility ?? "user",
			status: effectiveOptions.isBackground ? "queued" : "running",
			modelId: (effectiveOptions.model as { id?: string } | undefined)?.id,
			toolUses: 0,
			startedAt: Date.now(),
			abortController,
			sessionFile: effectiveOptions.sessionFile,
			taskRef: effectiveOptions.taskRef,
			currentAttemptId: 0,
			maxTurns: effectiveOptions.maxTurns,
			resumeAttempts: [],
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compactionCount: 0,
		}
		this.agents.set(id, record)

		const args: SpawnArgs = {
			pi,
			ctx,
			type,
			prompt: withAgentReportProtocol(prompt, effectiveOptions.taskRef),
			options: effectiveOptions,
		}

		if (
			effectiveOptions.isBackground &&
			!effectiveOptions.bypassQueue &&
			this.runningBackground >= this.maxConcurrent
		) {
			this.queue.push({ id, args })
			return id
		}

		try {
			this.startAgent(id, record, args)
		} catch (err) {
			this.agents.delete(id)
			throw err
		}
		return id
	}

	private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
		record.status = "running"
		record.startedAt = Date.now()
		record.isBackground = options.isBackground ?? false
		if (record.isBackground) this.runningBackground++
		this.onStart?.(record)

		let detachParentSignal: (() => void) | undefined
		if (options.signal) {
			const onParentAbort = () => this.abort(id)
			options.signal.addEventListener("abort", onParentAbort, { once: true })
			detachParentSignal = () => options.signal?.removeEventListener("abort", onParentAbort)
		}
		record.detachFromParent = () => {
			detachParentSignal?.()
			detachParentSignal = undefined
		}
		const detach = () => {
			record.detachFromParent?.()
			record.detachFromParent = undefined
		}

		const promise = runAgent(ctx, type, prompt, {
			pi,
			model: options.model,
			maxTurns: options.maxTurns,
			tokenBudget: options.tokenBudget,
			inactivityTimeout: options.inactivityTimeout,
			maxDuration: options.maxDuration,
			workerReport: record.taskRef
				? {
						isAccepted: () => record.agentReport?.attempt_id === record.currentAttemptId,
						submit: (report) => {
							const accepted = this.submitReport(id, report) != null
							return {
								accepted,
								message: accepted
									? "Agent report recorded. Worker run complete."
									: "Agent report rejected because this worker is no longer active.",
							}
						},
					}
				: undefined,
			hardTurnLimit: record.taskRef?.kind === "ferment_step",
			isolated: options.isolated,
			inheritContext: options.inheritContext,
			thinkingLevel: options.thinkingLevel,
			sessionFile: options.sessionFile,
			sessionDir: options.sessionDir,
			signal: record.abortController?.signal,
			onToolActivity: (activity) => {
				if (activity.type === "end") record.toolUses++
				options.onToolActivity?.(activity)
			},
			onTurnEnd: (turnCount) => {
				record.lastTurnCount = turnCount
				options.onTurnEnd?.(turnCount)
			},
			onTextDelta: options.onTextDelta,
			onAssistantUsage: (usage) => {
				addUsage(record.lifetimeUsage, usage)
				options.onAssistantUsage?.(usage)
			},
			onCompaction: (info) => {
				record.compactionCount++
				this.onCompact?.(record, info)
				options.onCompaction?.(info)
			},
			onRuntimeCleanupRegistered: (cleanup) => {
				this.runtimeCleanups.set(record, cleanup)
			},
			onSessionCreated: (session) => {
				record.session = session
				if (record.pendingSteers?.length) {
					for (const msg of record.pendingSteers) {
						session.steer(msg).catch(() => {})
					}
					record.pendingSteers = undefined
				}
				options.onSessionCreated?.(session)
			},
		})
			.then(({ responseText, session, aborted, abortReason, steered, turnsUsed, maxTurns }) => {
				if (record.status !== "stopped") {
					record.status = aborted ? "aborted" : steered ? "steered" : "completed"
				}
				record.abortReason = abortReason
				record.result = responseText
				record.session = session
				record.lastTurnCount = turnsUsed
				// Preserve the effective, normalized turn cap returned by the runner.
				record.maxTurns = maxTurns ?? options.maxTurns
				record.completedAt ??= Date.now()
				record.latestOutcome = buildAgentOutcome(record)

				if (record.isBackground) {
					this.runningBackground--
					this.onComplete?.(record)
					this.drainQueue()
				}
				return responseText
			})
			.catch((err) => {
				if (record.status !== "stopped") {
					record.status = "error"
					record.error = err instanceof Error ? err.message : String(err)
				}
				record.completedAt ??= Date.now()
				record.latestOutcome = buildAgentOutcome(record)

				if (record.isBackground) {
					this.runningBackground--
					this.onComplete?.(record)
					this.drainQueue()
				}
				return ""
			})
			.finally(() => {
				detach()
				this.cleanupRecordRuntime(record)
				record.promise = undefined
			})

		record.promise = promise
	}

	private drainQueue() {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			// biome-ignore lint/style/noNonNullAssertion: shift() is guaranteed non-undefined inside while(length > 0) loop
			const next = this.queue.shift()!
			const record = this.agents.get(next.id)
			if (!record || record.status !== "queued") continue
			// Snapshot the slot count so we can detect (and undo) startAgent's
			// background-slot increment when it throws synchronously. Without this,
			// a synchronous throw in startAgent leaks runningBackground forever.
			const beforeRunningBackground = this.runningBackground
			try {
				this.startAgent(next.id, record, next.args)
			} catch (err) {
				if (this.runningBackground > beforeRunningBackground) {
					this.runningBackground--
				}
				record.status = "error"
				record.error = err instanceof Error ? err.message : String(err)
				record.completedAt = Date.now()
				this.onComplete?.(record)
			}
		}
	}

	async spawnAndWait(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: Omit<SpawnOptions, "isBackground">,
	): Promise<AgentRecord> {
		const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false })
		// biome-ignore lint/style/noNonNullAssertion: spawn() just inserted this id into the agents map
		const record = this.agents.get(id)!
		await record.promise
		return record
	}

	detachToBackground(id: string): boolean {
		const record = this.agents.get(id)
		if (!record || record.status !== "running" || record.isBackground) return false
		if (!record.detachResolver) return false

		record.isBackground = true
		this.runningBackground++
		record.detachFromParent?.()
		record.detachFromParent = undefined
		record.detachResolver?.()
		record.detachResolver = undefined

		return true
	}

	async resume(
		id: string,
		prompt: string | undefined,
		options: {
			signal?: AbortSignal
			maxTurns?: number
			tokenBudget?: number
			inactivityTimeout?: number
			maxDuration?: number
			purpose?: "continuation" | "finalize_report"
		} = {},
	): Promise<AgentRecord | undefined> {
		const record = this.agents.get(id)
		if (!record?.session) return undefined
		const purpose = options.purpose ?? "continuation"
		if (this.getResumeBlockReason(id, purpose)) return record
		const tierBudget = record.taskRef ? FERMENT_WORKER_BUDGETS[record.taskRef.budget_tier ?? "standard"] : undefined
		const attemptLimits =
			purpose === "finalize_report"
				? REPORT_FINALIZATION_LIMITS
				: tierBudget
					? {
							...options,
							maxTurns: Math.min(options.maxTurns ?? tierBudget.maxTurns, tierBudget.maxTurns),
							maxDuration: Math.min(options.maxDuration ?? tierBudget.maxDuration, tierBudget.maxDuration),
							tokenBudget: Math.min(options.tokenBudget ?? tierBudget.tokenBudget, tierBudget.tokenBudget),
						}
					: options
		const remainingTokenBudget = record.taskRef
			? Math.max(0, cumulativeTokenBudget(record.taskRef) - record.lifetimeUsage.output)
			: undefined
		const attemptTokenBudget =
			remainingTokenBudget == null
				? attemptLimits.tokenBudget
				: Math.min(attemptLimits.tokenBudget ?? remainingTokenBudget, remainingTokenBudget)

		record.status = "running"
		record.completedAt = undefined
		record.result = undefined
		record.error = undefined
		record.abortReason = undefined
		record.maxTurns = attemptLimits.maxTurns
		record.lastTurnCount = 0
		record.currentAttemptId++
		record.agentReport = undefined
		const attemptStartedAt = Date.now()
		const attempt: AgentResumeAttempt = {
			attempt_id: record.currentAttemptId,
			purpose,
			startedAt: attemptStartedAt,
			maxTurns: attemptLimits.maxTurns,
			tokenBudget: attemptTokenBudget,
		}
		record.resumeAttempts ??= []
		record.resumeAttempts.push(attempt)
		const abortController = new AbortController()
		record.abortController = abortController
		const onCallerAbort = () => abortController.abort()
		if (options.signal?.aborted) abortController.abort()
		else options.signal?.addEventListener("abort", onCallerAbort, { once: true })

		const attemptPrompt =
			purpose === "finalize_report" && record.taskRef
				? reportFinalizationPrompt(record.taskRef)
				: withAgentReportProtocol(prompt ?? "", record.taskRef)
		const resumePromise = resumeAgent(record.session, attemptPrompt, {
			onToolActivity: (activity) => {
				if (activity.type === "end") record.toolUses++
			},
			onTurnEnd: (turnCount) => {
				record.lastTurnCount = turnCount
			},
			onAssistantUsage: (usage) => {
				addUsage(record.lifetimeUsage, usage)
			},
			onCompaction: (info) => {
				record.compactionCount++
				this.onCompact?.(record, info)
			},
			signal: abortController.signal,
			maxTurns: attemptLimits.maxTurns,
			tokenBudget: attemptTokenBudget,
			minTokenBudget: purpose === "finalize_report" ? MIN_FINALIZE_TOKEN_BUDGET : undefined,
			inactivityTimeout: options.inactivityTimeout,
			maxDuration: attemptLimits.maxDuration,
			hardTurnLimit: record.taskRef?.kind === "ferment_step",
			shouldTerminateAfterTool: (toolName) =>
				toolName === "submit_agent_report" && record.agentReport?.attempt_id === record.currentAttemptId,
			onRuntimeCleanupRegistered: (cleanup) => {
				this.runtimeCleanups.set(record, cleanup)
			},
		})
		this.activeResumePromises.set(record, resumePromise)

		try {
			const result = await resumePromise
			if ((record.status as AgentRecord["status"]) !== "stopped") {
				record.status = result.aborted ? "aborted" : result.steered ? "steered" : "completed"
			}
			record.abortReason = result.abortReason
			record.result = result.responseText
			record.lastTurnCount = result.turnsUsed
			record.maxTurns = result.maxTurns ?? attemptLimits.maxTurns
			record.completedAt = Date.now()
		} catch (err) {
			if ((record.status as AgentRecord["status"]) !== "stopped") {
				record.status = "error"
				record.error = err instanceof Error ? err.message : String(err)
			}
			record.completedAt = Date.now()
		} finally {
			options.signal?.removeEventListener("abort", onCallerAbort)
			this.activeResumePromises.delete(record)
			this.cleanupRecordRuntime(record)
		}
		attempt.completedAt = record.completedAt
		attempt.outcome = classifyAgentOutcome(record)
		attempt.reason = record.status === "error" ? "error" : record.abortReason
		record.latestOutcome = buildAgentOutcome(record)

		return record
	}

	getResumeBlockReason(id: string, purpose: "continuation" | "finalize_report"): string | undefined {
		const record = this.agents.get(id)
		if (!record?.session) return `Agent "${id}" has no active session to resume.`
		if (purpose === "finalize_report" && record.taskRef?.kind !== "ferment_step") {
			return `Agent "${id}" is not a Ferment-linked worker and cannot finalize a worker report.`
		}
		if (record.agentReport?.attempt_id === record.currentAttemptId && record.agentReport.status === "completed") {
			return `Agent "${id}" already has an accepted completed report for its current attempt.`
		}
		const attemptsForPurpose = record.resumeAttempts?.filter((attempt) => attempt.purpose === purpose).length ?? 0
		const attemptLimit =
			purpose === "finalize_report" ? DEFAULT_MAX_REPORT_FINALIZERS : DEFAULT_MAX_CONTINUATION_RESUMES
		if (record.taskRef?.kind === "ferment_step" && attemptsForPurpose >= attemptLimit) {
			return `Agent "${id}" has already used the Ferment worker ${purpose} resume limit (${attemptLimit}). Spawn a new linked worker for remaining work.`
		}
		if (record.taskRef && record.lifetimeUsage.output >= cumulativeTokenBudget(record.taskRef)) {
			return `Agent "${id}" exhausted the cumulative ${record.taskRef.budget_tier ?? "standard"} Ferment worker output budget (${cumulativeTokenBudget(record.taskRef)} tokens).`
		}
		if (record.taskRef) {
			const remaining = cumulativeTokenBudget(record.taskRef) - record.lifetimeUsage.output
			const minBudget = purpose === "finalize_report" ? MIN_FINALIZE_TOKEN_BUDGET : MIN_TOKEN_BUDGET
			if (remaining < minBudget) {
				return purpose === "finalize_report"
					? `Agent "${id}" has only ${remaining} output tokens remaining, below the minimum report-finalization budget (${minBudget} tokens). The session retains its work but cannot produce a structured report. Inspect the raw output and either spawn a replacement worker or stop and report the step as incomplete.`
					: `Agent "${id}" has only ${remaining} output tokens remaining, below the minimum enforceable resume budget (${minBudget} tokens). Spawn a new linked worker for remaining work.`
			}
		}
		return undefined
	}

	submitReport(agentId: string, report: WorkerReportSubmission): AgentRecord | undefined {
		const record = this.agents.get(agentId)
		if (!record || record.visibility === "system" || record.taskRef?.kind !== "ferment_step") return undefined
		record.agentReport = {
			...report,
			attempt_id: record.currentAttemptId,
			submitted_at: Date.now(),
		}
		record.latestOutcome = buildAgentOutcome(record)
		return record
	}

	getRecord(id: string): AgentRecord | undefined {
		return this.agents.get(id)
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt)
	}

	abort(id: string): boolean {
		const record = this.agents.get(id)
		if (!record) return false

		if (record.status === "queued") {
			this.queue = this.queue.filter((q) => q.id !== id)
			record.status = "stopped"
			record.completedAt = Date.now()
			return true
		}

		if (record.status !== "running") return false
		record.abortController?.abort()
		record.status = "stopped"
		record.completedAt = Date.now()
		return true
	}

	private cleanupRecordRuntime(record: AgentRecord): void {
		if (record.outputCleanup) {
			try {
				record.outputCleanup()
			} catch {
				/* ignore */
			}
			record.outputCleanup = undefined
		}
		const runtimeCleanup = this.runtimeCleanups.get(record)
		if (runtimeCleanup) {
			try {
				runtimeCleanup()
			} catch {
				/* ignore */
			}
			this.runtimeCleanups.delete(record)
		}
	}

	private removeRecord(id: string, record: AgentRecord): void {
		this.cleanupRecordRuntime(record)
		record.session?.dispose?.()
		record.session = undefined
		this.agents.delete(id)
	}

	private cleanup() {
		const cutoff = Date.now() - 10 * 60_000
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue
			if ((record.completedAt ?? 0) >= cutoff) continue
			this.removeRecord(id, record)
		}
	}

	clearCompleted(): void {
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue
			this.removeRecord(id, record)
		}
	}

	hasRunning(): boolean {
		return [...this.agents.values()].some((r) => r.status === "running" || r.status === "queued")
	}

	getRunningCount(): number {
		let count = 0
		for (const r of this.agents.values()) {
			if (r.status === "running" || r.status === "queued") count++
		}
		return count
	}

	abortAll(): number {
		let count = 0
		for (const queued of this.queue) {
			const record = this.agents.get(queued.id)
			if (record) {
				record.status = "stopped"
				record.completedAt = Date.now()
				count++
			}
		}
		this.queue = []
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort()
				record.status = "stopped"
				record.completedAt = Date.now()
				count++
			}
		}
		return count
	}

	async waitForAll(): Promise<void> {
		while (true) {
			this.drainQueue()
			const pending = [...this.agents.values()].flatMap((r) =>
				[r.promise, this.activeResumePromises.get(r)].filter(Boolean),
			)
			if (pending.length === 0) break
			await Promise.allSettled(pending)
		}
	}

	dispose() {
		clearInterval(this.cleanupInterval)
		this.queue = []
		for (const record of this.agents.values()) {
			this.cleanupRecordRuntime(record)
			record.session?.dispose()
		}
		this.agents.clear()
	}
}

export function classifyAgentOutcome(record: Pick<AgentRecord, "status" | "abortReason">): AgentOutcome["outcome"] {
	if (record.status === "completed" || record.status === "steered") return "completed"
	if (record.status === "stopped") return "stopped"
	if (record.status === "aborted" && (record.abortReason === "max_turns" || record.abortReason === "token_budget")) {
		return "budget_exhausted"
	}
	return "failed"
}

function buildRemainingWorkGuidance(
	outcome: AgentOutcome["outcome"],
	reason: AgentOutcome["reason"],
): string | undefined {
	if (outcome === "budget_exhausted") {
		return `Inspect the worker report before deciding what to do. Do not assume that steps_completed is correct or that remaining_steps is necessary. Compare both with the assigned step, success criteria, files touched, and verification evidence. Then choose:
- Call resume_subagent with a fresh, bounded budget if it only needs to continue valid work using the same approach.
- Call resume_subagent once with explicit new instructions if its approach was wrong but its context is still useful.
- Spawn a new linked Agent if the necessary remaining work is a separate, narrower task.
- Stop and report if the work is unnecessary, out of scope, or going in the wrong direction.
If the report is missing, call resume_subagent with purpose finalize_report before deciding.`
	}
	if (outcome === "failed" && (reason === "max_duration" || reason === "inactivity")) {
		return "Inspect the worker report before acting; this may indicate a hang, blocked command, or stalled investigation. Resume only with a steering prompt that avoids the stalled operation and continues the same thread. Otherwise spawn a narrower linked replacement Agent, or stop/report the blocker."
	}
	if (outcome === "failed") {
		return "Inspect the failure and worker report before acting. Spawn a corrected replacement Agent when remaining_steps have a clear task boundary, or stop/report if the failure is not recoverable through bounded delegation."
	}
	return undefined
}

export function buildAgentOutcome(record: AgentRecord): AgentOutcome {
	const outcome = classifyAgentOutcome(record)
	const reason = record.status === "error" ? "error" : record.abortReason
	const durationMs = (record.completedAt ?? Date.now()) - record.startedAt
	const text = record.result?.trim() || record.error?.trim()
	const resumable =
		record.session != null &&
		outcome !== "completed" &&
		outcome !== "stopped" &&
		(record.taskRef?.kind !== "ferment_step" ||
			(record.resumeAttempts?.filter((attempt) => attempt.purpose === "continuation").length ?? 0) <
				DEFAULT_MAX_CONTINUATION_RESUMES)
	const recoveryGuidance = buildRemainingWorkGuidance(outcome, reason)
	return {
		agent_id: record.id,
		status: record.status,
		outcome,
		reason,
		resumable,
		turns_used: record.lastTurnCount,
		max_turns: record.maxTurns,
		token_usage: { ...record.lifetimeUsage },
		duration_ms: durationMs,
		report: record.agentReport?.attempt_id === record.currentAttemptId ? record.agentReport : undefined,
		summary: record.agentReport?.attempt_id === record.currentAttemptId ? undefined : text,
		recovery_guidance: recoveryGuidance,
		task_ref: record.taskRef,
		resume_attempts: record.resumeAttempts?.length ?? 0,
	}
}
