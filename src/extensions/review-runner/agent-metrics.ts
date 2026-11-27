import type { RunResult, ToolActivity } from "../agents/manager/agent-runner.js"
import type { ReviewWorktree } from "./types.js"

export const REVIEW_AGENTS_STATE_VERSION = "review-agents/v1"

export interface ReviewModelUsage {
	provider: string
	model: string
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface ReviewAgentRunMetric {
	runId: string
	sequence: number
	writer: string
	role: "lens" | "verifier"
	worktreePath: string
	environmentReceiptDigest?: string
	sessionFile?: string
	startedAt: string
	endedAt: string
	durationMs: number
	durationSeconds: number
	turnsUsed?: number
	maxTurns?: number
	aborted: boolean
	abortReason?: RunResult["abortReason"]
	steered: boolean
	stopReason?: string
	firstSubmittedAt?: string
	models: ReviewModelUsage[]
	error?: string
}

const SUBMISSION_TOOLS = new Set(["submit_finding", "submit_summary", "submit_reconciliation"])

export function isReviewAgentSubmission(activity: ToolActivity): boolean {
	return activity.status === "completed" && SUBMISSION_TOOLS.has(activity.toolName)
}

export function terminalReviewStopReason(result: Pick<RunResult, "session">): string | undefined {
	return [...result.session.messages].reverse().find((message) => message.role === "assistant")?.stopReason
}

/** Aggregate assistant messages by their actual provider/model. The existing
 * differential child_usage stream remains responsible for delivery deadlines. */
export function reviewUsageByModel(result: Pick<RunResult, "session">): ReviewModelUsage[] {
	const models = new Map<string, ReviewModelUsage>()
	for (const message of result.session.messages) {
		if (message.role !== "assistant") continue
		const key = JSON.stringify([message.provider, message.model])
		const current = models.get(key) ?? {
			provider: message.provider,
			model: message.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}
		current.usage.input += message.usage.input
		current.usage.output += message.usage.output
		current.usage.cacheRead += message.usage.cacheRead
		current.usage.cacheWrite += message.usage.cacheWrite
		models.set(key, current)
	}
	return [...models.values()].sort((left, right) =>
		JSON.stringify([left.provider, left.model]).localeCompare(JSON.stringify([right.provider, right.model])),
	)
}

export function reviewAgentAttemptKey(
	metric: Pick<ReviewAgentRunMetric, "writer" | "sequence"> & Partial<Pick<ReviewAgentRunMetric, "runId">>,
): string {
	return `${metric.writer}:${metric.runId ?? "legacy"}:${metric.sequence}`
}

export function createReviewAgentMetric(options: {
	runId: string
	sequence: number
	writer: string
	kind?: "verifier"
	worktree: ReviewWorktree
	sessionFile?: string
	startedAt: number
	endedAt: number
	firstSubmittedAt?: number
	result?: RunResult
	error?: unknown
}): ReviewAgentRunMetric {
	const { result } = options
	return {
		runId: options.runId,
		sequence: options.sequence,
		writer: options.writer,
		role: options.kind === "verifier" ? "verifier" : "lens",
		worktreePath: options.worktree.path,
		...(options.worktree.environment ? { environmentReceiptDigest: options.worktree.environment.receiptDigest } : {}),
		...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
		startedAt: new Date(options.startedAt).toISOString(),
		endedAt: new Date(options.endedAt).toISOString(),
		durationMs: options.endedAt - options.startedAt,
		durationSeconds: (options.endedAt - options.startedAt) / 1000,
		...(result?.turnsUsed === undefined ? {} : { turnsUsed: result.turnsUsed }),
		...(result?.maxTurns === undefined ? {} : { maxTurns: result.maxTurns }),
		aborted: result?.aborted ?? false,
		...(result?.abortReason === undefined ? {} : { abortReason: result.abortReason }),
		steered: result?.steered ?? false,
		...(result ? { stopReason: terminalReviewStopReason(result) } : {}),
		...(options.firstSubmittedAt === undefined
			? {}
			: { firstSubmittedAt: new Date(options.firstSubmittedAt).toISOString() }),
		models: result ? reviewUsageByModel(result) : [],
		...(options.error === undefined
			? {}
			: { error: (options.error instanceof Error ? options.error.message : String(options.error)).slice(0, 2000) }),
	}
}
