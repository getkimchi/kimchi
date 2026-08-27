import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../../config.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { resolveClonePlan } from "../../teleport/provisioning/clone-plan.js"
import { repoBasename } from "../../teleport/provisioning/paths.js"
import type { AgentContact, AgentContactList, AgentMessageCapability } from "../message-tool.js"
import {
	AGENT_MESSAGE_LIMITS,
	type AgentMessage,
	type AgentMessageInput,
	type AgentMessageReceipt,
	type AgentMessageReservation,
	type AgentMessageThread,
	createAgentMessage,
	createChildIdempotencyKey,
	createDuplicateMessageKey,
	createParentReplyIdempotencyKey,
	findOldestClosedThread,
	validateAgentMessageInput,
} from "../messages.js"
import type {
	AgentCommunicationMode,
	AgentCommunicationScope,
	AgentOutcome,
	AgentRecord,
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
	type RunResult,
	resumeAgent,
	runAgent,
	type ToolActivity,
} from "./agent-runner.js"
import { runRemoteAgent } from "./remote-agent-runner.js"
import { addUsage, type LifetimeUsage } from "./usage.js"

export type OnAgentComplete = (record: AgentRecord) => void
export type OnAgentStart = (record: AgentRecord, ctx: ExtensionContext) => void
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_CONTINUATION_RESUMES = 2
const DEFAULT_MAX_REPORT_FINALIZERS = 1
const REPORT_FINALIZATION_LIMITS = { maxTurns: 2, maxDuration: 30, tokenBudget: 8192 } as const

/** Result shape returned by `_runRemote()`, mirroring `RunResult` from agent-runner.ts. */
type RemoteRunResult = Omit<RunResult, "session"> & { session: undefined }

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
	communication?: AgentCommunicationMode
	/** Parent session ID, supplied by the host Agent tool when communication is enabled. */
	rootSessionId?: string
	model?: Model<Api>
	maxTurns?: number
	isolated?: boolean
	inheritContext?: boolean
	thinkingLevel?: ThinkingLevel
	isBackground?: boolean
	/** When true, runs on a remote sandbox via ACP instead of locally. */
	remote?: boolean
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
	onRawNotification?: (params: SessionNotification) => void
	onCompaction?: (info: CompactionInfo) => void
}

interface MessageReceiptEntry {
	agentId: string
	promise: Promise<AgentMessageReceipt>
}

interface PendingMessageUsage {
	count: number
	bytes: number
}

interface PendingAgentMessage {
	messageId: string
	threadId: string
	sourceAgentId: string
	sourceTaskId: string
	targetAgentId: string
	rootSessionId: string
	kind: AgentMessage["payload"]["kind"]
	prompt: string
	bytes: number
	terminalized?: boolean
}

export interface AgentMessageBrokerStats {
	receipts: number
	threads: number
	pendingMessages: number
	pendingPayloadBytes: number
}

export type AgentParentNotification =
	| { kind: "message"; message: AgentMessage }
	| {
			kind: "delivery_failure"
			messageId: string
			sourceAgentId: string
			targetAgentId: string
			reason: string
			escapeHatch: string
	  }

export interface AgentMessageEvent {
	messageId: string
	threadId: string
	sourceAgentId: string
	targetType: AgentMessage["recipient"]["type"]
	targetAgentId?: string
	kind: AgentMessage["payload"]["kind"]
	state: AgentMessageReceipt["status"]
	bytes: number
	sourceTaskId: string
}

export type AgentParentBridge = (notification: AgentParentNotification, rootSessionId: string) => boolean

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
	private pendingDrainPromises = new WeakMap<AgentRecord, Promise<void>>()
	private messageReceipts = new Map<string, MessageReceiptEntry>()
	private receiptKeysByAgent = new Map<string, Set<string>>()
	private messageAttemptCounts = new Map<string, Map<number, number>>()
	private messageThreads = new Map<string, AgentMessageThread>()
	private threadIdsByAgent = new Map<string, Set<string>>()
	private pendingMessageUsage = new Map<string, PendingMessageUsage>()
	private pendingMessages = new Map<string, PendingAgentMessage[]>()
	private deliveryFailureKeys = new Map<string, string>()
	/** Send signature (createDuplicateMessageKey) → last-sent epoch ms. */
	private loopGuardKeys = new Map<string, number>()
	private communicationRootSessionId?: string
	private parentBridge?: AgentParentBridge
	private userContactResolver?: (rootSessionId: string) => AgentContact
	private onMessageEvent?: (event: AgentMessageEvent) => void
	private communicationDisabled = false
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
		const communication = effectiveOptions.visibility === "system" ? undefined : effectiveOptions.communication
		const rootSessionId = effectiveOptions.rootSessionId?.trim()
		if (communication && effectiveOptions.isolated) {
			throw new Error("Communication requires extension tools and cannot be used with isolated agents.")
		}
		if (communication && !rootSessionId) {
			throw new Error("Communication requires a host-owned root session ID.")
		}
		const abortController = new AbortController()
		const record: AgentRecord = {
			id,
			type,
			description: effectiveOptions.description,
			visibility: effectiveOptions.visibility ?? "user",
			communication,
			communicationScope:
				communication && rootSessionId
					? {
							rootSessionId,
							sourceAgentId: id,
							taskId: `agent-task:${id}`,
						}
					: undefined,
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
			remote: effectiveOptions.remote,
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
		this.onStart?.(record, ctx)

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

		const promise = (
			record.remote
				? this._runRemote(record, prompt, options, ctx)
				: runAgent(ctx, type, prompt, {
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
						agentMessage: this.createMessageCapability(record),
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
							const drain = this.drainPendingMessages(record, session)
							this.pendingDrainPromises.set(record, drain)
							options.onSessionCreated?.(session)
						},
						onSystemPrompt: (prompt) => {
							record.systemPrompt = prompt
						},
					})
		)
			.then(async ({ responseText, session, aborted, abortReason, steered, turnsUsed, maxTurns, planPath }) => {
				await this.pendingDrainPromises.get(record)
				record.session = session
				if (record.status !== "stopped") {
					this.transitionToTerminalRecord(record, aborted ? "aborted" : steered ? "steered" : "completed")
				}
				record.abortReason = abortReason
				const finalText = planPath ? `${responseText}\n\nPlan saved to: ${planPath}` : responseText
				record.result = finalText
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
				return finalText
			})
			.catch(async (err) => {
				await this.pendingDrainPromises.get(record)
				if (record.status !== "stopped") {
					this.transitionToTerminalRecord(record, "error")
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
				this.pendingDrainPromises.delete(record)
				this.cleanupRecordRuntime(record)
				record.promise = undefined
			})

		record.promise = promise
	}

	/**
	 * Runs a remote agent via ACP on a sandbox worker.
	 *
	 * v1 limitation: only a subset of SpawnOptions is honored — signal, callbacks, and
	 * cwd are forwarded, but maxTurns, tokenBudget, inactivityTimeout, maxDuration,
	 * model, isolated, inheritContext, and thinkingLevel are intentionally ignored.
	 * Remote runs are single-turn (maxTurns: 1) with yolo: true. Multi-turn support,
	 * budget enforcement, and timeout guards are planned for a follow-up PR.
	 */
	private async _runRemote(
		record: AgentRecord,
		prompt: string,
		options: SpawnOptions,
		ctx: ExtensionContext,
	): Promise<RemoteRunResult> {
		const apiKey = loadConfig().apiKey
		if (!apiKey) throw new Error("No API key configured. Run `kimchi login`.")

		const workspaces = await listWorkspaces(apiKey, {
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
			signal: record.abortController?.signal,
		})
		// Match a workspace whose name matches the current repo dir (same convention
		// as /teleport, which names workspaces by basename(cwd)). If no match is
		// found, mint a new one rather than reusing an unrelated workspace.
		const dirName = basename(ctx.cwd) || "kimchi"
		const byName = workspaces.find((w) => w.name.toLowerCase() === dirName.toLowerCase())
		const workspaceId = byName?.id ?? randomUUID()

		// Resolve git clone plan from the local repo so the sandbox gets a
		// shallow clone of the repo (like /teleport --fast) instead of an empty dir.
		// If cwd isn't a git repo or has no origin, this is a no-op.
		let gitDetails: { repo: string; branch?: string; targetDirectory: string; noHistory?: boolean } | undefined
		try {
			const clonePlan = await resolveClonePlan(ctx.cwd, undefined, { signal: record.abortController?.signal })
			gitDetails = {
				repo: clonePlan.httpsUrl,
				branch: clonePlan.branch,
				targetDirectory: repoBasename(clonePlan.url),
				noHistory: true,
			}
		} catch {
			// Not a git repo or no origin — proceed without git details.
			gitDetails = undefined
		}

		const result = await runRemoteAgent(workspaceId, prompt, {
			apiKey,
			endpoint: process.env.KIMCHI_REMOTE_ENDPOINT,
			signal: record.abortController?.signal,
			gitDetails,
			localPath: ctx.cwd,
			workspaceName: dirName,
			callbacks: {
				onTextDelta: (delta, fullText) => options.onTextDelta?.(delta, fullText),
				onToolActivity: (activity) => {
					if (activity.type === "end") record.toolUses++
					options.onToolActivity?.(activity)
				},
				onTurnEnd: (turnCount) => {
					record.lastTurnCount = turnCount
					options.onTurnEnd?.(turnCount)
				},
				onAssistantUsage: (usage) => {
					addUsage(record.lifetimeUsage, usage)
					options.onAssistantUsage?.(usage)
				},
				onRawNotification: (params) => {
					options.onRawNotification?.(params)
				},
			},
		})

		return {
			responseText: result.responseText,
			session: undefined,
			aborted: result.stopReason === "cancelled",
			abortReason: undefined,
			steered: false,
			turnsUsed: 1,
			maxTurns: undefined,
		}
	}

	private drainQueue() {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			// biome-ignore lint/style/noNonNullAssertion: shift() is guaranteed non-undefined inside while(length > 0) loop
			const next = this.queue.shift()!
			const record = this.agents.get(next.id)
			if (record?.status !== "queued") continue
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
				this.transitionToTerminalRecord(record, "error")
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
		if (record?.status !== "running" || record.isBackground) return false
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
				this.transitionToTerminalRecord(record, result.aborted ? "aborted" : result.steered ? "steered" : "completed")
			}
			record.abortReason = result.abortReason
			record.result = result.responseText
			record.lastTurnCount = result.turnsUsed
			record.maxTurns = result.maxTurns ?? attemptLimits.maxTurns
			record.completedAt = Date.now()
		} catch (err) {
			if ((record.status as AgentRecord["status"]) !== "stopped") {
				this.transitionToTerminalRecord(record, "error")
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
		attempt.reason = record.error ? "error" : record.abortReason
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

	getCommunicationScope(agentId: string): AgentCommunicationScope | undefined {
		const scope = this.agents.get(agentId)?.communicationScope
		return scope ? { ...scope } : undefined
	}

	bindCommunicationRoot(rootSessionId: string): boolean {
		const root = rootSessionId.trim()
		if (
			!root ||
			this.communicationDisabled ||
			(this.communicationRootSessionId && this.communicationRootSessionId !== root)
		)
			return false
		this.communicationRootSessionId = root
		this.communicationDisabled = false
		return true
	}

	registerParentBridge(rootSessionId: string, bridge: AgentParentBridge): boolean {
		if (!this.bindCommunicationRoot(rootSessionId)) return false
		this.parentBridge = bridge
		return true
	}

	setUserContactResolver(rootSessionId: string, resolver: (rootSessionId: string) => AgentContact): boolean {
		if (!this.bindCommunicationRoot(rootSessionId)) return false
		this.userContactResolver = resolver
		return true
	}

	setMessageEventHandler(handler: ((event: AgentMessageEvent) => void) | undefined): void {
		this.onMessageEvent = handler
	}

	disableCommunication(rootSessionId?: string): boolean {
		if (rootSessionId && this.communicationRootSessionId !== rootSessionId) return false
		this.parentBridge = undefined
		this.userContactResolver = undefined
		this.communicationDisabled = true
		this.terminalizeAllPendingMessages("shutdown", false)
		this.clearMessageBroker()
		return true
	}

	getCommunicationContacts(agentId: string): AgentContactList {
		const source = this.agents.get(agentId)
		const root = source?.communicationScope?.rootSessionId
		const active = Boolean(
			source?.communication && root && !this.communicationDisabled && this.communicationRootSessionId === root,
		)
		const parent: AgentContact =
			active && this.parentBridge
				? { reachable: true, route: "parent" }
				: { reachable: false, route: "unavailable", reason: "The parent communication route is unavailable." }
		const user: AgentContact =
			active && root !== undefined && this.userContactResolver
				? this.userContactResolver(root)
				: { reachable: false, route: "unavailable", reason: "The user route is unavailable." }
		const peers = active
			? this.listCommunicationPeers(agentId).map((record) => ({
					agent_id: record.id,
					task_id: record.communicationScope?.taskId,
					persona: record.type,
					description: record.description,
					status: record.session ? record.status : "initializing",
					reachable: true,
					route: "peer" as const,
				}))
			: []
		return { parent, user_via_parent: user, peers }
	}

	private createMessageCapability(record: AgentRecord): AgentMessageCapability | undefined {
		const scope = record.communicationScope
		if (!record.communication || !scope || record.visibility === "system") return undefined
		const sourceAgentId = record.id
		const rootSessionId = scope.rootSessionId
		const taskId = scope.taskId
		return {
			listContacts: () => this.getCommunicationContacts(sourceAgentId),
			sendMessage: (toolCallId, input) =>
				this.sendChildMessage(sourceAgentId, rootSessionId, taskId, toolCallId, input),
		}
	}

	private sendChildMessage(
		sourceAgentId: string,
		rootSessionId: string,
		taskId: string,
		toolCallId: string,
		input: AgentMessageInput,
	): Promise<AgentMessageReceipt> {
		const validated = validateAgentMessageInput(input)
		if (!validated.valid) return Promise.resolve({ status: "rejected", reason: validated.reason })
		const { recipient, payload } = validated.value
		const isReply = payload.kind === "answer" || payload.kind === "decline"
		// Loop guard: identical semantic payloads from one source to one
		// recipient inside the window are dropped. Receipt reservations already
		// dedupe retried tool calls; this catches model send-loops. The guard
		// binds only to real delivery attempts — failover statuses below stay
		// retryable because retrying a terminal failure is an escape hatch.
		const guardKey = isReply ? undefined : createDuplicateMessageKey(sourceAgentId, recipient, payload)
		if (guardKey && this.isDuplicateSend(guardKey, Date.now())) {
			return Promise.resolve({
				status: "rejected",
				reason:
					`Duplicate message dropped: an identical payload was sent within the last ` +
					`${AGENT_MESSAGE_LIMITS.duplicateMessageWindowMs / 1000}s. Do not re-send; use the first attempt's outcome.`,
			})
		}
		const recordOutcome = (delivery: Promise<AgentMessageReceipt>): Promise<AgentMessageReceipt> => {
			if (!guardKey) return delivery
			return delivery.then((receipt) => {
				if (receipt.status !== "rejected" && receipt.status !== "unavailable" && receipt.status !== "saturated") {
					this.recordSendSignature(guardKey, Date.now())
				}
				return receipt
			})
		}
		if (recipient.type === "agent") {
			if (isReply) {
				const replyTo = "reply_to" in validated.value ? validated.value.reply_to : undefined
				if (!replyTo) return Promise.resolve({ status: "rejected", reason: "Answers and declines require reply_to." })
				return this.reservePeerReply(
					sourceAgentId,
					replyTo,
					recipient.agentId,
					toolCallId,
					validated.bytes,
					payload.kind,
					(reservation) => {
						const thread = this.messageThreads.get(replyTo)
						const target = this.getAuthorizedPeer(sourceAgentId, recipient.agentId, rootSessionId)
						if (!thread || !target) return { status: "unavailable", reason: "The peer route is unavailable." }
						const message = createAgentMessage(reservation, randomUUID(), recipient, payload, {
							replyTo,
							threadId: thread.id,
						})
						return this.deliverPeerMessage(message, target, validated.bytes)
					},
				)
			}
			return recordOutcome(
				this.reserveChildMessage(sourceAgentId, toolCallId, validated.bytes, (reservation) => {
					const source = this.agents.get(sourceAgentId)
					if (!this.hasActiveCommunicationSource(source, rootSessionId, taskId)) {
						return { status: "unavailable", reason: "The parent communication route is unavailable." }
					}
					const target = this.getAuthorizedPeer(sourceAgentId, recipient.agentId, rootSessionId)
					if (!target) return { status: "unavailable", reason: "The peer route is unavailable." }
					const message = createAgentMessage(reservation, randomUUID(), recipient, payload)
					return this.deliverPeerMessage(message, target, validated.bytes)
				}),
			)
		}
		return recordOutcome(
			this.reserveChildMessage(sourceAgentId, toolCallId, validated.bytes, (reservation) => {
				const source = this.agents.get(sourceAgentId)
				if (!this.hasActiveCommunicationSource(source, rootSessionId, taskId)) {
					return { status: "unavailable", reason: "The parent communication route is unavailable." }
				}
				if (recipient.type === "user" && payload.kind !== "question") {
					return { status: "rejected", reason: "The user route accepts questions only." }
				}
				const bridge = this.parentBridge
				if (!bridge) return { status: "unavailable", reason: "The parent communication route is unavailable." }
				const message = createAgentMessage(
					reservation,
					randomUUID(),
					recipient,
					payload,
					"reply_to" in validated.value ? { replyTo: validated.value.reply_to } : undefined,
				)
				const thread = this.registerMessageThread(message)
				if (!thread.accepted) return { status: "unavailable", reason: thread.reason }
				if (!bridge({ kind: "message", message }, rootSessionId)) {
					this.removeMessageThread(message.threadId)
					return { status: "unavailable", reason: "The parent communication route is unavailable." }
				}
				const receipt: AgentMessageReceipt = {
					messageId: message.id,
					threadId: message.threadId,
					status: "queued_for_parent",
				}
				this.emitMessageEvent(message, receipt.status, validated.bytes)
				return receipt
			}),
		)
	}

	private hasActiveCommunicationSource(
		source: AgentRecord | undefined,
		rootSessionId: string,
		taskId: string,
	): boolean {
		return Boolean(
			source?.communicationScope &&
				source.communicationScope.rootSessionId === rootSessionId &&
				source.communicationScope.taskId === taskId &&
				!this.communicationDisabled &&
				this.communicationRootSessionId === rootSessionId,
		)
	}

	private getAuthorizedPeer(
		sourceAgentId: string,
		targetAgentId: string,
		rootSessionId: string,
	): AgentRecord | undefined {
		if (this.communicationDisabled || this.communicationRootSessionId !== rootSessionId) return undefined
		return this.listCommunicationPeers(sourceAgentId).find((record) => record.id === targetAgentId)
	}

	private deliverPeerMessage(message: AgentMessage, target: AgentRecord, bytes: number): Promise<AgentMessageReceipt> {
		const delivery = this.createPendingDelivery(message, target.id, bytes)
		const needsThread = message.payload.kind !== "answer" && message.payload.kind !== "decline"
		if (!target.session) {
			if (!this.tryReservePendingMessage(target.id, bytes)) {
				return Promise.resolve({
					status: "saturated",
					reason: "Pending peer message storage is full.",
					escapeHatch: "Send the message to the parent or submit a final report.",
				})
			}
			if (needsThread) {
				const thread = this.registerMessageThread(message)
				if (!thread.accepted) {
					this.releasePendingMessage(target.id, bytes)
					return Promise.resolve({ status: "unavailable", reason: thread.reason })
				}
			}
			this.addPendingMessage(delivery)
			const receipt: AgentMessageReceipt = {
				messageId: message.id,
				threadId: message.threadId,
				status: "queued_before_session",
			}
			this.emitMessageEvent(message, receipt.status, bytes)
			return Promise.resolve(receipt)
		}
		if (needsThread) {
			const thread = this.registerMessageThread(message)
			if (!thread.accepted) return Promise.resolve({ status: "unavailable", reason: thread.reason })
		}
		return target.session.steer(delivery.prompt).then(
			() => {
				const receipt: AgentMessageReceipt = {
					messageId: message.id,
					threadId: message.threadId,
					status: "queued_for_running_session",
				}
				this.emitMessageEvent(message, receipt.status, bytes)
				return receipt
			},
			() => {
				this.failPendingMessage(delivery, "steer_failed", true, false)
				return { status: "unavailable", reason: "The peer route is unavailable." }
			},
		)
	}

	private createPendingDelivery(message: AgentMessage, targetAgentId: string, bytes: number): PendingAgentMessage {
		return {
			messageId: message.id,
			threadId: message.threadId,
			sourceAgentId: message.sourceAgentId,
			sourceTaskId: message.sourceTaskId,
			targetAgentId,
			rootSessionId: message.rootSessionId,
			kind: message.payload.kind,
			prompt: `Host-mediated message from peer ${message.sourceAgentId}${message.replyTo ? ` replying to ${message.replyTo}` : ""}:\n${JSON.stringify(message.payload)}`,
			bytes,
		}
	}

	private addPendingMessage(message: PendingAgentMessage): void {
		const messages = this.pendingMessages.get(message.targetAgentId) ?? []
		messages.push(message)
		this.pendingMessages.set(message.targetAgentId, messages)
	}

	private emitMessageEvent(message: AgentMessage, state: AgentMessageReceipt["status"], bytes: number): void {
		this.onMessageEvent?.({
			messageId: message.id,
			threadId: message.threadId,
			sourceAgentId: message.sourceAgentId,
			targetType: message.recipient.type,
			targetAgentId: message.recipient.type === "agent" ? message.recipient.agentId : undefined,
			kind: message.payload.kind,
			state,
			bytes,
			sourceTaskId: message.sourceTaskId,
		})
	}

	private emitPendingMessageEvent(message: PendingAgentMessage, state: AgentMessageReceipt["status"]): void {
		this.onMessageEvent?.({
			messageId: message.messageId,
			threadId: message.threadId,
			sourceAgentId: message.sourceAgentId,
			targetType: "agent",
			targetAgentId: message.targetAgentId,
			kind: message.kind,
			state,
			bytes: message.bytes,
			sourceTaskId: message.sourceTaskId,
		})
	}

	/** Returns only live peers authorized by the host-created batch group. */
	listCommunicationPeers(agentId: string): AgentRecord[] {
		const source = this.agents.get(agentId)
		if (!source?.communicationScope || source.communication !== "group" || !source.groupId) return []
		return [...this.agents.values()].filter(
			(target) =>
				target.id !== source.id &&
				target.status !== "completed" &&
				target.status !== "steered" &&
				target.status !== "aborted" &&
				target.status !== "stopped" &&
				target.status !== "error" &&
				target.communication === "group" &&
				target.communicationScope?.rootSessionId === source.communicationScope?.rootSessionId &&
				target.groupId === source.groupId,
		)
	}

	isAuthorizedCommunicationPeer(sourceAgentId: string, targetAgentId: string): boolean {
		return this.listCommunicationPeers(sourceAgentId).some((record) => record.id === targetAgentId)
	}

	/**
	 * Atomically reserves a child tool-call key before starting the operation.
	 * Callers receive the same in-flight receipt for repeated executions.
	 */
	reserveChildMessage(
		agentId: string,
		toolCallId: string,
		payloadBytes: number,
		operation: (reservation: AgentMessageReservation) => AgentMessageReceipt | Promise<AgentMessageReceipt>,
	): Promise<AgentMessageReceipt> {
		const record = this.agents.get(agentId)
		const scope = record?.communicationScope
		if (!record || !scope) {
			return Promise.resolve({
				status: "unavailable",
				reason: "Agent communication is not enabled for this host-owned record.",
			})
		}

		const sourceAttemptId = record.currentAttemptId
		const idempotencyKey = createChildIdempotencyKey(scope, sourceAttemptId, toolCallId)
		const cached = this.messageReceipts.get(idempotencyKey)
		if (cached) return cached.promise
		if (payloadBytes > AGENT_MESSAGE_LIMITS.maxPayloadBytes) {
			return Promise.resolve({
				status: "rejected",
				reason: `Message payload exceeds ${AGENT_MESSAGE_LIMITS.maxPayloadBytes} bytes.`,
			})
		}

		const attempts = this.messageAttemptCounts.get(agentId) ?? new Map<number, number>()
		if ((attempts.get(sourceAttemptId) ?? 0) >= AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt) {
			return Promise.resolve({
				status: "saturated",
				reason: `Agent attempt reached the ${AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt}-message limit.`,
				escapeHatch: "Continue safe work or submit a final report.",
			})
		}
		if (!this.canStoreReceipt(agentId)) {
			return Promise.resolve({
				status: "saturated",
				reason: "Message receipt storage is full.",
				escapeHatch: "Continue safe work or submit a final report.",
			})
		}

		attempts.set(sourceAttemptId, (attempts.get(sourceAttemptId) ?? 0) + 1)
		this.messageAttemptCounts.set(agentId, attempts)
		return this.reserveReceipt(
			agentId,
			idempotencyKey,
			{
				idempotencyKey,
				scope: { ...scope },
				sourceAttemptId,
			},
			operation,
		)
	}

	reserveParentReply(
		messageId: string,
		toolCallId: string,
		closeReason: "parent_answer" | "parent_decline",
		operation: () => AgentMessageReceipt | Promise<AgentMessageReceipt>,
	): Promise<AgentMessageReceipt> {
		const thread = this.messageThreads.get(messageId)
		if (!thread) return Promise.resolve({ status: "rejected", reason: "Unknown message thread." })
		const idempotencyKey = createParentReplyIdempotencyKey(thread.rootSessionId, messageId, toolCallId)
		const cached = this.messageReceipts.get(idempotencyKey)
		if (cached) return cached.promise
		if (thread.recipient.type === "agent") {
			return Promise.resolve({ status: "rejected", reason: "Parent is not the expected responder." })
		}
		if (thread.state !== "open") return Promise.resolve({ status: "rejected", reason: "thread_closed" })
		if (thread.messageCount >= AGENT_MESSAGE_LIMITS.maxMessagesPerThread) {
			return Promise.resolve({ status: "saturated", reason: "Message thread reached its message limit." })
		}
		if (!this.canStoreReceipt(thread.sourceAgentId)) {
			return Promise.resolve({
				status: "saturated",
				reason: "Message receipt storage is full.",
				escapeHatch: "Use the agent's final report for remaining state.",
			})
		}
		const scope = this.agents.get(thread.sourceAgentId)?.communicationScope
		if (!scope) return Promise.resolve({ status: "unavailable", reason: "The source agent is no longer available." })
		return this.reserveReceipt(
			thread.sourceAgentId,
			idempotencyKey,
			{
				idempotencyKey,
				scope: { ...scope },
				sourceAttemptId: this.agents.get(thread.sourceAgentId)?.currentAttemptId ?? 0,
			},
			() => {
				const closed = this.closeThreadForAnswer(thread, closeReason)
				if (!closed) return { status: "rejected", reason: "thread_closed" }
				return operation()
			},
		)
	}

	async replyToAgentMessage(
		rootSessionId: string,
		messageId: string,
		toolCallId: string,
		answer: string,
		options: { maxTurns: number; maxDuration: number; tokenBudget?: number; answerKind?: "answer" | "decline" },
		signal?: AbortSignal,
	): Promise<AgentMessageReceipt> {
		if (signal?.aborted) return { status: "rejected", reason: "Message reply was aborted." }
		if (
			!Number.isInteger(options.maxTurns) ||
			options.maxTurns <= 0 ||
			!Number.isFinite(options.maxDuration) ||
			options.maxDuration <= 0 ||
			(options.tokenBudget != null &&
				(!Number.isInteger(options.tokenBudget) || options.tokenBudget < MIN_TOKEN_BUDGET))
		) {
			return {
				status: "rejected",
				reason: `max_turns and max_duration must be positive; token_budget must be at least ${MIN_TOKEN_BUDGET}.`,
			}
		}
		const answerBytes = Buffer.byteLength(answer, "utf8")
		if (answerBytes > AGENT_MESSAGE_LIMITS.maxPayloadBytes) {
			return {
				status: "rejected",
				reason: `Message payload exceeds ${AGENT_MESSAGE_LIMITS.maxPayloadBytes} bytes.`,
			}
		}
		if (this.communicationDisabled || this.communicationRootSessionId !== rootSessionId) {
			return { status: "rejected", reason: "This message reply is not authorized for the current root." }
		}
		const thread = this.messageThreads.get(messageId)
		if (!thread || thread.rootSessionId !== rootSessionId) {
			return { status: "rejected", reason: "This message reply is not authorized for the current root." }
		}
		return this.reserveParentReply(
			messageId,
			toolCallId,
			options.answerKind === "decline" ? "parent_decline" : "parent_answer",
			async () => {
				const target = this.agents.get(thread.sourceAgentId)
				if (
					!target?.communicationScope ||
					target.communicationScope.rootSessionId !== rootSessionId ||
					target.communicationScope.taskId !== thread.sourceTaskId
				) {
					return { status: "unavailable", reason: "The source agent is no longer available." }
				}
				const delivery: PendingAgentMessage = {
					messageId,
					threadId: thread.id,
					sourceAgentId: target.id,
					sourceTaskId: thread.sourceTaskId,
					targetAgentId: target.id,
					rootSessionId,
					kind: "answer",
					prompt:
						options.answerKind === "decline"
							? `Host-mediated decline to your message ${messageId}:\n${answer}\nDo not resend this question — continue with your declared canContinue plan, or submit a blocked final report if you cannot proceed.`
							: `Host-mediated answer to your message ${messageId}:\n${answer}`,
					bytes: answerBytes,
				}
				if (target.agentReport?.attempt_id === target.currentAttemptId && target.agentReport.status === "completed") {
					return {
						status: "unavailable",
						reason:
							this.getResumeBlockReason(target.id, "continuation") ?? "The source agent already completed its report.",
					}
				}
				if (target.status === "running" || target.status === "queued") {
					if (!target.session) {
						if (!this.tryReservePendingMessage(target.id, delivery.bytes)) {
							return {
								status: "saturated",
								reason: "Pending reply storage is full.",
								escapeHatch: "Use the agent's final report for remaining state.",
							}
						}
						this.addPendingMessage(delivery)
						this.emitPendingMessageEvent(delivery, "queued_before_session")
						return { messageId, threadId: thread.id, status: "queued_before_session" }
					}
					try {
						await target.session.steer(delivery.prompt)
						this.emitPendingMessageEvent(delivery, "queued_for_running_session")
						return { messageId, threadId: thread.id, status: "queued_for_running_session" }
					} catch {
						this.failPendingMessage(delivery, "steer_failed", true, false)
						return { status: "unavailable", reason: "The source agent is no longer reachable." }
					}
				}
				if (target.status === "stopped") {
					return { status: "unavailable", reason: "Stopped agents cannot be resumed by message reply." }
				}
				if (
					target.status !== "completed" &&
					target.status !== "steered" &&
					target.status !== "aborted" &&
					target.status !== "error"
				) {
					return { status: "unavailable", reason: "The source agent is no longer reachable." }
				}
				const blockReason = this.getResumeBlockReason(target.id, "continuation")
				if (blockReason) return { status: "unavailable", reason: blockReason }
				const resumed = await this.resume(target.id, delivery.prompt, {
					signal,
					maxTurns: options.maxTurns,
					maxDuration: options.maxDuration,
					tokenBudget: options.tokenBudget,
					purpose: "continuation",
				})
				return {
					messageId,
					threadId: thread.id,
					status: "resume_attempt_completed",
					agentOutcome: resumed?.latestOutcome,
				}
			},
		)
	}

	/**
	 * Reserves a host-authorized peer answer. The caller still performs no transport here;
	 * this contract only binds the responder and target before the first await.
	 */
	reservePeerReply(
		responderAgentId: string,
		messageId: string,
		targetAgentId: string,
		toolCallId: string,
		payloadBytes: number,
		payloadKind: "answer" | "decline",
		operation: (reservation: AgentMessageReservation) => AgentMessageReceipt | Promise<AgentMessageReceipt>,
	): Promise<AgentMessageReceipt> {
		const responder = this.agents.get(responderAgentId)
		const scope = responder?.communicationScope
		if (!responder || !scope) {
			return Promise.resolve({ status: "rejected", reason: "Peer reply is not authorized." })
		}
		if (!this.isStaticAuthorizedCommunicationPeer(responderAgentId, targetAgentId, scope.rootSessionId)) {
			return Promise.resolve({ status: "rejected", reason: "Peer reply is not authorized." })
		}
		const sourceAttemptId = responder.currentAttemptId
		const idempotencyKey = createChildIdempotencyKey(scope, sourceAttemptId, toolCallId)
		const cached = this.messageReceipts.get(idempotencyKey)
		if (cached) return cached.promise

		const thread = this.messageThreads.get(messageId)
		if (!thread) return Promise.resolve({ status: "rejected", reason: "Peer reply is not authorized." })
		if (
			thread.recipient.type !== "agent" ||
			thread.recipient.agentId !== responderAgentId ||
			thread.sourceAgentId !== targetAgentId ||
			scope.rootSessionId !== thread.rootSessionId
		) {
			return Promise.resolve({ status: "rejected", reason: "Peer reply is not authorized." })
		}
		if (thread.state !== "open") return Promise.resolve({ status: "rejected", reason: "thread_closed" })
		if (payloadBytes > AGENT_MESSAGE_LIMITS.maxPayloadBytes) {
			return Promise.resolve({
				status: "rejected",
				reason: `Message payload exceeds ${AGENT_MESSAGE_LIMITS.maxPayloadBytes} bytes.`,
			})
		}
		if (thread.messageCount >= AGENT_MESSAGE_LIMITS.maxMessagesPerThread) {
			return Promise.resolve({ status: "saturated", reason: "Message thread reached its message limit." })
		}

		const attempts = this.messageAttemptCounts.get(responderAgentId) ?? new Map<number, number>()
		if ((attempts.get(sourceAttemptId) ?? 0) >= AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt) {
			return Promise.resolve({
				status: "saturated",
				reason: `Agent attempt reached the ${AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt}-message limit.`,
				escapeHatch: "Send the question to the parent or submit a final report.",
			})
		}
		if (!this.canStoreReceipt(responderAgentId)) {
			return Promise.resolve({
				status: "saturated",
				reason: "Message receipt storage is full.",
				escapeHatch: "Send the question to the parent or submit a final report.",
			})
		}

		attempts.set(sourceAttemptId, (attempts.get(sourceAttemptId) ?? 0) + 1)
		this.messageAttemptCounts.set(responderAgentId, attempts)
		return this.reserveReceipt(
			responderAgentId,
			idempotencyKey,
			{ idempotencyKey, scope: { ...scope }, sourceAttemptId },
			(reservation) => {
				const closed = this.closeThreadForAnswer(thread, payloadKind === "decline" ? "peer_decline" : "peer_answer")
				if (!closed) return { status: "rejected", reason: "thread_closed" }
				return operation(reservation)
			},
		)
	}

	private isStaticAuthorizedCommunicationPeer(
		sourceAgentId: string,
		targetAgentId: string,
		rootSessionId: string,
	): boolean {
		const source = this.agents.get(sourceAgentId)
		const target = this.agents.get(targetAgentId)
		return Boolean(
			!this.communicationDisabled &&
				this.communicationRootSessionId === rootSessionId &&
				source?.communication === "group" &&
				source.communicationScope?.rootSessionId === rootSessionId &&
				source.groupId &&
				target?.communication === "group" &&
				target.communicationScope?.rootSessionId === rootSessionId &&
				target.groupId === source.groupId,
		)
	}

	/** Stores only body-free thread metadata after a route has accepted a message. */
	registerMessageThread(message: AgentMessage): { accepted: true } | { accepted: false; reason: string } {
		const source = this.agents.get(message.sourceAgentId)
		const scope = source?.communicationScope
		if (
			!scope ||
			scope.rootSessionId !== message.rootSessionId ||
			scope.sourceAgentId !== message.sourceAgentId ||
			scope.taskId !== message.sourceTaskId ||
			source.currentAttemptId !== message.sourceAttemptId
		) {
			return { accepted: false, reason: "Message identity does not match the live host-owned record." }
		}
		if (message.payload.kind === "answer" || message.payload.kind === "decline") {
			return { accepted: false, reason: "Answers and declines must close their existing question thread." }
		}
		if (message.threadId !== message.id || this.messageThreads.has(message.threadId)) {
			return { accepted: false, reason: "Initial messages require a new unique thread ID." }
		}
		const thread: AgentMessageThread =
			message.payload.kind === "question"
				? {
						id: message.threadId,
						rootSessionId: message.rootSessionId,
						questionMessageId: message.id,
						sourceAgentId: message.sourceAgentId,
						sourceTaskId: message.sourceTaskId,
						recipient: message.recipient,
						expectedResponder: message.recipient.type === "agent" ? "agent" : "parent",
						state: "open",
						messageCount: 1,
						createdAt: message.createdAt,
					}
				: {
						id: message.threadId,
						rootSessionId: message.rootSessionId,
						questionMessageId: message.id,
						sourceAgentId: message.sourceAgentId,
						sourceTaskId: message.sourceTaskId,
						recipient: message.recipient,
						expectedResponder: message.recipient.type === "agent" ? "agent" : "parent",
						state: "closed",
						messageCount: 1,
						createdAt: message.createdAt,
						closedAt: message.createdAt,
						closeReason: "single_message",
					}
		if (
			thread.state === "open" &&
			this.countOpenThreads(message.sourceAgentId) >= AGENT_MESSAGE_LIMITS.maxOpenQuestionsPerAgent
		) {
			return { accepted: false, reason: "Agent has too many open message questions." }
		}
		if (!this.canStoreThread(message.sourceAgentId)) {
			return { accepted: false, reason: "Message thread storage is full." }
		}

		this.messageThreads.set(thread.id, thread)
		const threadIds = this.threadIdsByAgent.get(message.sourceAgentId) ?? new Set<string>()
		threadIds.add(thread.id)
		this.threadIdsByAgent.set(message.sourceAgentId, threadIds)
		return { accepted: true }
	}

	/** Generic terminal closure for lifecycle code; it never impersonates an answer. */
	closeMessageThreadForTerminalState(
		questionMessageId: string,
		reason: string,
	): { closed: true; thread: AgentMessageThread } | { closed: false; reason: string } {
		const thread = this.messageThreads.get(questionMessageId)
		if (!thread) return { closed: false, reason: "unknown_thread" }
		if (thread.state !== "open") return { closed: false, reason: "thread_closed" }
		thread.state = "closed"
		thread.closedAt = Date.now()
		thread.closeReason = reason
		return { closed: true, thread: { ...thread } }
	}

	/** Capacity-only reservation for future body-free thread records. */
	tryReserveThreadMessage(questionMessageId: string): boolean {
		const thread = this.messageThreads.get(questionMessageId)
		return thread?.state === "open" && this.reserveThreadMessage(thread)
	}

	getMessageThread(questionMessageId: string): AgentMessageThread | undefined {
		const thread = this.messageThreads.get(questionMessageId)
		return thread ? { ...thread } : undefined
	}

	private async drainPendingMessages(record: AgentRecord, session: AgentSession): Promise<void> {
		while (true) {
			const pending = this.pendingMessages.get(record.id)?.[0]
			if (!pending) return
			try {
				await session.steer(pending.prompt)
			} catch {
				this.terminalizePendingForTarget(record.id, "steer_failed", true)
				return
			}
			if (pending.terminalized) continue
			this.removePendingMessage(pending)
			this.emitPendingMessageEvent(pending, "queued_for_running_session")
		}
	}

	private removePendingMessage(message: PendingAgentMessage): void {
		const messages = this.pendingMessages.get(message.targetAgentId)
		if (!messages) return
		const index = messages.indexOf(message)
		if (index < 0) return
		messages.splice(index, 1)
		if (messages.length === 0) this.pendingMessages.delete(message.targetAgentId)
		this.releasePendingMessage(message.targetAgentId, message.bytes)
	}

	private terminalizePendingForTarget(targetAgentId: string, reason: string, notifyParent: boolean): void {
		const messages = this.pendingMessages.get(targetAgentId)
		if (!messages) return
		this.pendingMessages.delete(targetAgentId)
		for (const message of messages) this.failPendingMessage(message, reason, notifyParent, true)
	}

	private terminalizePendingFromSource(
		sourceAgentId: string,
		reason: string,
		notifyParent: boolean,
		onlyLiveResponderMessages = false,
	): void {
		for (const [targetAgentId, messages] of this.pendingMessages) {
			const affected = messages.filter(
				(message) =>
					message.sourceAgentId === sourceAgentId && (!onlyLiveResponderMessages || message.kind === "question"),
			)
			if (affected.length === 0) continue
			const remaining = messages.filter((message) => !affected.includes(message))
			if (remaining.length === 0) this.pendingMessages.delete(targetAgentId)
			else this.pendingMessages.set(targetAgentId, remaining)
			for (const message of affected) this.failPendingMessage(message, reason, notifyParent, true)
		}
	}

	private terminalizeAllPendingMessages(reason: string, notifyParent: boolean): void {
		for (const targetAgentId of [...this.pendingMessages.keys()]) {
			this.terminalizePendingForTarget(targetAgentId, reason, notifyParent)
		}
	}

	private failPendingMessage(
		message: PendingAgentMessage,
		reason: string,
		notifyParent: boolean,
		releasePending: boolean,
	): void {
		if (message.terminalized) return
		message.terminalized = true
		if (releasePending) this.releasePendingMessage(message.targetAgentId, message.bytes)
		this.closeMessageThreadForTerminalState(message.messageId, reason)
		const failureKey = `${message.rootSessionId}:delivery-failure:${message.messageId}`
		if (this.reserveDeliveryFailureKey(failureKey, message.sourceAgentId)) {
			if (
				notifyParent &&
				!this.communicationDisabled &&
				this.communicationRootSessionId === message.rootSessionId &&
				this.parentBridge
			) {
				this.parentBridge(
					{
						kind: "delivery_failure",
						messageId: message.messageId,
						sourceAgentId: message.sourceAgentId,
						targetAgentId: message.targetAgentId,
						reason,
						escapeHatch: "Send a new message to the parent or use the agent's final report.",
					},
					message.rootSessionId,
				)
			}
		}
		this.emitPendingMessageEvent(message, "unavailable")
	}

	private transitionToTerminalRecord(
		record: AgentRecord,
		status: Extract<AgentRecord["status"], "completed" | "steered" | "aborted" | "stopped" | "error">,
	): void {
		this.closeOpenPeerThreadsForAgent(record.id)
		if (
			status === "stopped" ||
			!record.session ||
			(record.agentReport?.attempt_id === record.currentAttemptId && record.agentReport.status === "completed")
		) {
			this.closeOpenParentThreadsForAgent(record.id, "participant_terminal")
		}
		this.terminalizePendingForTarget(record.id, "participant_terminal", true)
		this.terminalizePendingFromSource(record.id, "participant_terminal", true, true)
		record.status = status
	}

	private closeOpenPeerThreadsForAgent(agentId: string): void {
		for (const thread of this.messageThreads.values()) {
			if (
				thread.state === "open" &&
				thread.recipient.type === "agent" &&
				(thread.sourceAgentId === agentId || thread.recipient.agentId === agentId)
			) {
				this.closeMessageThreadForTerminalState(thread.questionMessageId, "participant_terminal")
			}
		}
	}

	private closeOpenParentThreadsForAgent(agentId: string, reason: string): void {
		for (const thread of this.messageThreads.values()) {
			if (thread.state === "open" && thread.recipient.type !== "agent" && thread.sourceAgentId === agentId) {
				this.closeMessageThreadForTerminalState(thread.questionMessageId, reason)
			}
		}
	}

	tryReservePendingMessage(targetAgentId: string, payloadBytes: number): boolean {
		if (
			payloadBytes > AGENT_MESSAGE_LIMITS.maxPayloadBytes ||
			this.pendingPayloadBytes() + payloadBytes > AGENT_MESSAGE_LIMITS.maxPendingPayloadBytes
		) {
			return false
		}
		if (this.metadataRecordCount() >= AGENT_MESSAGE_LIMITS.maxMetadataRecords) return false
		const usage = this.pendingMessageUsage.get(targetAgentId) ?? { count: 0, bytes: 0 }
		if (usage.count >= AGENT_MESSAGE_LIMITS.maxPendingMessagesPerTarget) return false
		usage.count++
		usage.bytes += payloadBytes
		this.pendingMessageUsage.set(targetAgentId, usage)
		return true
	}

	releasePendingMessage(targetAgentId: string, payloadBytes: number): void {
		const usage = this.pendingMessageUsage.get(targetAgentId)
		if (!usage) return
		usage.count--
		usage.bytes = Math.max(0, usage.bytes - payloadBytes)
		if (usage.count <= 0) this.pendingMessageUsage.delete(targetAgentId)
	}

	getMessageBrokerStats(): AgentMessageBrokerStats {
		return {
			receipts: this.messageReceipts.size,
			threads: this.messageThreads.size,
			pendingMessages: [...this.pendingMessageUsage.values()].reduce((count, usage) => count + usage.count, 0),
			pendingPayloadBytes: this.pendingPayloadBytes(),
		}
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt)
	}

	/** Register a transient agent record for visual purposes (overlay/widget)
	 *  without starting a full agent loop. The caller is responsible for
	 *  calling completeTransient(id) when done. */
	registerTransient(description: string): string {
		const id = randomUUID().slice(0, 17)
		const record: AgentRecord = {
			id,
			type: "general-purpose" as SubagentType,
			description,
			visibility: "user",
			status: "running",
			toolUses: 0,
			startedAt: Date.now(),
			currentAttemptId: 0,
			maxTurns: 1,
			resumeAttempts: [],
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compactionCount: 0,
		}
		this.agents.set(id, record)
		return id
	}

	/** Mark a transient agent record as complete and schedule cleanup. */
	completeTransient(id: string): void {
		const record = this.agents.get(id)
		if (!record) return
		this.transitionToTerminalRecord(record, "completed")
		record.completedAt = Date.now()
		// Schedule removal after a short delay — long enough for the widget to
		// render one final "✓ done" frame, but not so long it lingers in listAgents().
		setTimeout(() => this.removeRecord(id, record), 2000)
	}

	abort(id: string): boolean {
		const record = this.agents.get(id)
		if (!record) return false

		if (record.status === "queued") {
			this.queue = this.queue.filter((q) => q.id !== id)
			this.transitionToTerminalRecord(record, "stopped")
			record.completedAt = Date.now()
			return true
		}

		if (record.status !== "running") return false
		record.abortController?.abort()
		this.transitionToTerminalRecord(record, "stopped")
		record.completedAt = Date.now()
		return true
	}

	private reserveReceipt(
		agentId: string,
		idempotencyKey: string,
		reservation: AgentMessageReservation,
		operation: (reservation: AgentMessageReservation) => AgentMessageReceipt | Promise<AgentMessageReceipt>,
	): Promise<AgentMessageReceipt> {
		let resolve!: (receipt: AgentMessageReceipt) => void
		const promise = new Promise<AgentMessageReceipt>((resolvePromise) => {
			resolve = resolvePromise
		})
		this.messageReceipts.set(idempotencyKey, { agentId, promise })
		const receiptKeys = this.receiptKeysByAgent.get(agentId) ?? new Set<string>()
		receiptKeys.add(idempotencyKey)
		this.receiptKeysByAgent.set(agentId, receiptKeys)

		try {
			const result = operation(reservation)
			void Promise.resolve(result).then(resolve, () =>
				resolve({ status: "unavailable", reason: "The host message route became unavailable." }),
			)
		} catch {
			resolve({ status: "unavailable", reason: "The host message route became unavailable." })
		}
		return promise
	}

	private closeThreadForAnswer(thread: AgentMessageThread, reason: string): boolean {
		if (thread.state !== "open" || !this.reserveThreadMessage(thread)) return false
		thread.state = "closed"
		thread.closedAt = Date.now()
		thread.closeReason = reason
		return true
	}

	private reserveThreadMessage(thread: AgentMessageThread): boolean {
		if (thread.messageCount >= AGENT_MESSAGE_LIMITS.maxMessagesPerThread) return false
		thread.messageCount++
		return true
	}

	private canStoreReceipt(agentId: string): boolean {
		const receiptKeys = this.receiptKeysByAgent.get(agentId)
		return (
			(receiptKeys?.size ?? 0) < AGENT_MESSAGE_LIMITS.maxReceiptsPerAgent &&
			this.metadataRecordCount() < AGENT_MESSAGE_LIMITS.maxMetadataRecords
		)
	}

	private canStoreThread(agentId: string): boolean {
		const threadIds = this.threadIdsByAgent.get(agentId)
		if ((threadIds?.size ?? 0) >= AGENT_MESSAGE_LIMITS.maxThreadsPerAgent && !this.evictOldestClosedThread(agentId)) {
			return false
		}
		return this.metadataRecordCount() < AGENT_MESSAGE_LIMITS.maxMetadataRecords
	}

	private evictOldestClosedThread(agentId: string): boolean {
		const threadIds = this.threadIdsByAgent.get(agentId)
		if (!threadIds) return false
		const oldest = findOldestClosedThread(
			[...threadIds]
				.map((threadId) => this.messageThreads.get(threadId))
				.filter((thread): thread is AgentMessageThread => thread != null),
		)
		if (!oldest) return false
		this.messageThreads.delete(oldest.id)
		threadIds.delete(oldest.id)
		if (threadIds.size === 0) this.threadIdsByAgent.delete(agentId)
		return true
	}

	private removeMessageThread(threadId: string): void {
		const thread = this.messageThreads.get(threadId)
		if (!thread) return
		this.messageThreads.delete(threadId)
		const threadIds = this.threadIdsByAgent.get(thread.sourceAgentId)
		if (!threadIds) return
		threadIds.delete(threadId)
		if (threadIds.size === 0) this.threadIdsByAgent.delete(thread.sourceAgentId)
	}

	private countOpenThreads(agentId: string): number {
		const threadIds = this.threadIdsByAgent.get(agentId)
		if (!threadIds) return 0
		let count = 0
		for (const threadId of threadIds) {
			if (this.messageThreads.get(threadId)?.state === "open") count++
		}
		return count
	}

	private metadataRecordCount(): number {
		return (
			this.messageReceipts.size +
			this.messageThreads.size +
			[...this.pendingMessageUsage.values()].reduce((count, usage) => count + usage.count, 0) +
			this.deliveryFailureKeys.size +
			this.loopGuardKeys.size
		)
	}

	private reserveDeliveryFailureKey(failureKey: string, sourceAgentId: string): boolean {
		if (this.deliveryFailureKeys.has(failureKey)) return false
		while (this.metadataRecordCount() >= AGENT_MESSAGE_LIMITS.maxMetadataRecords) {
			if (!this.evictOldestClosedThreadGlobally() && !this.evictOldestDeliveryFailureKey()) {
				return false
			}
		}
		this.deliveryFailureKeys.set(failureKey, sourceAgentId)
		return true
	}

	private evictOldestClosedThreadGlobally(): boolean {
		const oldest = findOldestClosedThread([...this.messageThreads.values()])
		if (!oldest) return false
		this.removeMessageThread(oldest.id)
		return true
	}

	private evictOldestDeliveryFailureKey(): boolean {
		const oldest = this.deliveryFailureKeys.keys().next().value
		if (!oldest) return false
		this.deliveryFailureKeys.delete(oldest)
		return true
	}

	/**
	 * Loop guard: true when the identical source→recipient payload already
	 * delivered inside the window.
	 */
	private isDuplicateSend(key: string, now: number): boolean {
		const seenAt = this.loopGuardKeys.get(key)
		return seenAt !== undefined && now - seenAt < AGENT_MESSAGE_LIMITS.duplicateMessageWindowMs
	}

	/** Records a delivered send for the loop guard. Fails silently at the
	 *  metadata ceiling — the guard is advisory and must never suppress a
	 *  legitimate send (mirrors failure-notification omission). */
	private recordSendSignature(key: string, now: number): void {
		this.pruneExpiredLoopGuardKeys(now)
		if (!this.loopGuardKeys.has(key)) {
			while (this.metadataRecordCount() >= AGENT_MESSAGE_LIMITS.maxMetadataRecords) {
				if (
					!this.evictOldestLoopGuardKey() &&
					!this.evictOldestClosedThreadGlobally() &&
					!this.evictOldestDeliveryFailureKey()
				) {
					return
				}
			}
		}
		this.loopGuardKeys.set(key, now)
	}

	private pruneExpiredLoopGuardKeys(now: number): void {
		if (this.loopGuardKeys.size === 0) return
		for (const [key, seenAt] of this.loopGuardKeys) {
			if (now - seenAt >= AGENT_MESSAGE_LIMITS.duplicateMessageWindowMs) this.loopGuardKeys.delete(key)
		}
	}

	private evictOldestLoopGuardKey(): boolean {
		const oldest = this.loopGuardKeys.keys().next().value
		if (oldest === undefined) return false
		this.loopGuardKeys.delete(oldest)
		return true
	}

	private pendingPayloadBytes(): number {
		return [...this.pendingMessageUsage.values()].reduce((bytes, usage) => bytes + usage.bytes, 0)
	}

	private clearMessageBrokerForAgent(agentId: string): void {
		for (const key of this.receiptKeysByAgent.get(agentId) ?? []) this.messageReceipts.delete(key)
		this.receiptKeysByAgent.delete(agentId)
		this.messageAttemptCounts.delete(agentId)
		for (const [threadId, thread] of this.messageThreads) {
			if (
				thread.sourceAgentId === agentId ||
				(thread.recipient.type === "agent" && thread.recipient.agentId === agentId)
			) {
				this.messageThreads.delete(threadId)
				this.threadIdsByAgent.get(thread.sourceAgentId)?.delete(threadId)
			}
		}
		for (const [sourceAgentId, threadIds] of this.threadIdsByAgent) {
			if (threadIds.size === 0) this.threadIdsByAgent.delete(sourceAgentId)
		}
		for (const [failureKey, sourceAgentId] of this.deliveryFailureKeys) {
			if (sourceAgentId === agentId) this.deliveryFailureKeys.delete(failureKey)
		}
		for (const loopKey of this.loopGuardKeys.keys()) {
			if (loopKey.startsWith(`${agentId}|`)) this.loopGuardKeys.delete(loopKey)
		}
		this.pendingMessageUsage.delete(agentId)
	}

	private clearMessageBroker(): void {
		this.messageReceipts.clear()
		this.receiptKeysByAgent.clear()
		this.messageAttemptCounts.clear()
		this.messageThreads.clear()
		this.threadIdsByAgent.clear()
		this.pendingMessageUsage.clear()
		this.pendingMessages.clear()
		this.deliveryFailureKeys.clear()
		this.loopGuardKeys.clear()
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
		this.closeOpenPeerThreadsForAgent(id)
		this.closeOpenParentThreadsForAgent(id, "record_removed")
		this.terminalizePendingForTarget(id, "record_removed", true)
		this.terminalizePendingFromSource(id, "record_removed", true)
		this.clearMessageBrokerForAgent(id)
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
				this.transitionToTerminalRecord(record, "stopped")
				record.completedAt = Date.now()
				count++
			}
		}
		this.queue = []
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort()
				this.transitionToTerminalRecord(record, "stopped")
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
		this.parentBridge = undefined
		this.userContactResolver = undefined
		this.communicationDisabled = true
		this.terminalizeAllPendingMessages("shutdown", false)
		this.queue = []
		for (const record of this.agents.values()) {
			this.cleanupRecordRuntime(record)
			record.session?.dispose()
		}
		this.clearMessageBroker()
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
