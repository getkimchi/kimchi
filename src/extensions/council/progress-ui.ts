import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type {
	CouncilProgressEvent,
	CouncilRole,
	CouncilTransactionProgressPhase,
	SafeCouncilFailureReason,
} from "./schemas.js"

export const COUNCIL_PROGRESS_WIDGET_KEY = "council-progress"

const STATUS_KEY = "council"
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const ROLE_ORDER: CouncilRole[] = ["lead", "solver", "analyst", "synthesis", "combined", "repair"]
const ROLE_LABELS: Record<CouncilRole, string> = {
	lead: "exploring",
	solver: "solving",
	analyst: "comparing",
	synthesis: "writing",
	combined: "writing",
	repair: "checking",
}
const TRANSACTION_PHASE_LABELS: Record<CouncilTransactionProgressPhase, string> = {
	exploring: "exploring",
	solving: "solving",
	comparing: "comparing",
	writing: "writing",
	applying: "applying",
	checking: "checking",
}
const SAFE_FAILURE_LABELS: Record<SafeCouncilFailureReason, string> = {
	cancelled: "cancelled",
	timed_out: "timed out",
	panel_unavailable: "panel unavailable",
	validation_failed: "validation failed",
	limit_reached: "limit reached",
}

type StageStatus = "pending" | "running" | "completed" | "failed"
type StageView = { status: StageStatus; durationMs?: number; reason?: SafeCouncilFailureReason }
type Theme = {
	bold(text: string): string
	fg(color: string, text: string): string
}

function formatDuration(durationMs: number): string {
	return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`
}

function formatCost(value: number | undefined): string | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
	if (value >= 0.01) return `$${value.toFixed(2)}`
	const decimals = Math.min(20, Math.max(3, Math.ceil(-Math.log10(value)) + 2))
	let amount = value.toFixed(decimals).replace(/\.?0+$/, "")
	if (Number(amount) === 0) {
		const [mantissa, exponent] = value.toExponential(2).split("e")
		amount = `${mantissa?.replace(/\.?0+$/, "")}e${exponent}`
	}
	return `$${amount}`
}

function completedSummary(event: Extract<CouncilProgressEvent, { type: "run_completed" }>): string {
	const outcome = event.outcome === "tool_use" ? "tool requested" : event.outcome
	const parts = [`${event.outcome === "degraded" ? "⚠" : "✓"} Council`, outcome]
	parts.push(formatDuration(event.durationMs))
	const cost = formatCost(event.estimatedCostUsd)
	if (cost) parts.push(cost)
	return parts.join(" · ")
}

function failedSummary(event: Extract<CouncilProgressEvent, { type: "run_failed" | "run_aborted" }>): string {
	if (event.type === "run_aborted") return `⚠ Council · cancelled · ${formatDuration(event.durationMs)}`
	return `✗ Council · could not safely finalize · ${SAFE_FAILURE_LABELS[event.reason]} · ${formatDuration(event.durationMs)}`
}

export interface CouncilProgressEmitterOptions {
	runId: string
	startedAt: number
	hasTransaction: boolean
	onProgress?: (event: CouncilProgressEvent) => void
	getEstimatedCostUsd: () => number
	expectedSolverCount?: number
}

export interface CouncilProgressEmitter {
	emitProgress(event: CouncilProgressEvent): void
	emitTransactionProgress(phase: CouncilTransactionProgressPhase): void
	startStage(role: CouncilRole): void
	completeStage(role: CouncilRole): void
	failStage(role: CouncilRole, reason: SafeCouncilFailureReason): void
	failActiveStages(reason: SafeCouncilFailureReason): void
	emitRunCompleted(finalOutcome: "accepted" | "tool_use" | "degraded"): void
	emitRunFailure(aborted: boolean, reason: SafeCouncilFailureReason): void
}

export function createCouncilProgressEmitter(options: CouncilProgressEmitterOptions): CouncilProgressEmitter {
	const { runId, startedAt, hasTransaction, onProgress, getEstimatedCostUsd } = options
	const logicalStages = new Map<CouncilRole, { stageId: string; startedAt: number; terminal: boolean }>()
	const solverProgress = { completed: 0, failed: 0, expected: Math.max(1, options.expectedSolverCount ?? 1) }
	let runTerminalEmitted = false
	let lastTransactionPhase: CouncilTransactionProgressPhase | undefined

	const emitProgress = (event: CouncilProgressEvent): void => {
		try {
			onProgress?.(event)
		} catch {
			// Progress is best-effort and must not affect a model response.
		}
	}
	const emitTransactionProgress = (phase: CouncilTransactionProgressPhase): void => {
		if (!hasTransaction || lastTransactionPhase === phase) return
		lastTransactionPhase = phase
		emitProgress({ type: "transaction_progress", runId, phase })
	}
	const startStage = (role: CouncilRole): void => {
		if (logicalStages.has(role)) return
		const state = { stageId: `${runId}:${role}`, startedAt: Date.now(), terminal: false }
		logicalStages.set(role, state)
		emitProgress({ type: "stage_started", runId, stageId: state.stageId, role, startedAt: state.startedAt })
	}
	const completeStage = (role: CouncilRole): void => {
		const state = logicalStages.get(role)
		if (!state || state.terminal) return
		if (role === "solver") {
			solverProgress.completed += 1
			if (solverProgress.completed + solverProgress.failed < solverProgress.expected) return
		}
		state.terminal = true
		emitProgress({
			type: "stage_completed",
			runId,
			stageId: state.stageId,
			role,
			durationMs: Math.max(0, Date.now() - state.startedAt),
		})
	}
	const failStage = (role: CouncilRole, reason: SafeCouncilFailureReason): void => {
		const state = logicalStages.get(role)
		if (!state || state.terminal) return
		if (role === "solver") {
			solverProgress.failed += 1
			if (solverProgress.completed + solverProgress.failed < solverProgress.expected) return
		}
		state.terminal = true
		emitProgress({
			type: "stage_failed",
			runId,
			stageId: state.stageId,
			role,
			durationMs: Math.max(0, Date.now() - state.startedAt),
			reason,
		})
	}
	const failActiveStages = (reason: SafeCouncilFailureReason): void => {
		for (const [role, state] of logicalStages) {
			if (!state.terminal) failStage(role, reason)
		}
	}
	const emitRunCompleted = (finalOutcome: "accepted" | "tool_use" | "degraded"): void => {
		if (runTerminalEmitted) return
		runTerminalEmitted = true
		const estimatedCostUsd = getEstimatedCostUsd()
		emitProgress({
			type: "run_completed",
			runId,
			outcome: finalOutcome,
			durationMs: Math.max(0, Date.now() - startedAt),
			...(Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
		})
	}
	const emitRunFailure = (aborted: boolean, reason: SafeCouncilFailureReason): void => {
		if (runTerminalEmitted) return
		runTerminalEmitted = true
		emitProgress({
			type: aborted ? "run_aborted" : "run_failed",
			runId,
			durationMs: Math.max(0, Date.now() - startedAt),
			reason,
		})
	}

	return {
		emitProgress,
		emitTransactionProgress,
		startStage,
		completeStage,
		failStage,
		failActiveStages,
		emitRunCompleted,
		emitRunFailure,
	}
}

export class CouncilProgressUI {
	private activeRunId: string | undefined
	private lastStartedAt = Number.NEGATIVE_INFINITY
	private seenRunIds = new Set<string>()
	private stages = new Map<CouncilRole, StageView>()
	private transactionPhase?: CouncilTransactionProgressPhase
	private spinnerFrame = 0
	private timer: ReturnType<typeof setInterval> | undefined
	private tui: { requestRender(): void } | undefined
	private mounted = false
	private hasSummary = false
	private disposed = false

	constructor(private readonly ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">) {}

	handle(event: CouncilProgressEvent): void {
		if (this.disposed) return
		if (event.type === "run_started") {
			if (this.seenRunIds.has(event.runId)) return
			this.seenRunIds.add(event.runId)
			if (event.startedAt < this.lastStartedAt) return
			this.startRun(event)
			return
		}
		if (!this.activeRunId || event.runId !== this.activeRunId) return

		if (event.type === "transaction_progress") {
			this.transactionPhase = event.phase
			this.requestRender()
			return
		}
		if (event.type === "stage_started") {
			const stage = this.stages.get(event.role)
			if (stage && stage.status !== "pending") return
			this.stages.set(event.role, { status: "running" })
			this.requestRender()
			return
		}
		if (event.type === "stage_completed") {
			const stage = this.stages.get(event.role)
			if (stage?.status === "completed" || stage?.status === "failed") return
			this.stages.set(event.role, { status: "completed", durationMs: event.durationMs })
			this.requestRender()
			return
		}
		if (event.type === "stage_failed") {
			const stage = this.stages.get(event.role)
			if (stage?.status === "completed" || stage?.status === "failed") return
			this.stages.set(event.role, {
				status: "failed",
				durationMs: event.durationMs,
				reason: event.reason,
			})
			this.requestRender()
			return
		}

		this.stopLiveProgress()
		this.activeRunId = undefined
		this.stages.clear()
		this.transactionPhase = undefined
		const summary = event.type === "run_completed" ? completedSummary(event) : failedSummary(event)
		this.ui.setStatus(STATUS_KEY, summary)
		this.ui.setWidget(COUNCIL_PROGRESS_WIDGET_KEY, [summary], WIDGET_OPTIONS)
		this.mounted = true
		this.hasSummary = true
	}

	clear(): void {
		this.stopLiveProgress()
		this.activeRunId = undefined
		this.stages.clear()
		this.transactionPhase = undefined
		if (this.hasSummary) {
			this.ui.setStatus(STATUS_KEY, undefined)
			this.hasSummary = false
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.clear()
	}

	private startRun(event: Extract<CouncilProgressEvent, { type: "run_started" }>): void {
		this.stopLiveProgress()
		if (this.hasSummary) {
			this.ui.setStatus(STATUS_KEY, undefined)
			this.hasSummary = false
		}
		this.lastStartedAt = event.startedAt
		this.activeRunId = event.runId
		this.spinnerFrame = 0
		this.stages.clear()
		this.transactionPhase = undefined
		this.stages.set("lead", { status: "pending" })
		this.stages.set("solver", { status: "pending" })
		this.mount()
		this.timer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
			this.requestRender()
		}, 80)
	}

	private mount(): void {
		this.ui.setWidget(
			COUNCIL_PROGRESS_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui
				return {
					render: (width) => this.render(width, theme),
					invalidate: () => {},
					dispose: () => {
						if (this.tui === tui) this.tui = undefined
					},
				}
			},
			WIDGET_OPTIONS,
		)
		this.mounted = true
	}

	private stopLiveProgress(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		if (this.mounted) this.ui.setWidget(COUNCIL_PROGRESS_WIDGET_KEY, undefined, WIDGET_OPTIONS)
		this.mounted = false
		this.tui = undefined
	}

	private requestRender(): void {
		this.tui?.requestRender()
	}

	private render(width: number, theme: Theme): string[] {
		const runningRoles = ROLE_ORDER.filter((role) => this.stages.get(role)?.status === "running")
		const headline = this.transactionPhase
			? TRANSACTION_PHASE_LABELS[this.transactionPhase]
			: runningRoles.includes("repair")
				? "checking"
				: runningRoles.includes("analyst")
					? "comparing"
					: runningRoles.includes("synthesis") || runningRoles.includes("combined")
						? "writing"
						: runningRoles.includes("solver")
							? "solving"
							: "exploring"
		const spinner = theme.fg("accent", SPINNER[this.spinnerFrame] ?? SPINNER[0] ?? "•")
		const lines = [theme.bold(`${spinner} Council · ${headline}`)]
		const visibleRoles = ROLE_ORDER.filter((role) => {
			if (role === "lead") return false
			return this.stages.has(role)
		})
		for (const [index, role] of visibleRoles.entries()) {
			const stage = this.stages.get(role)
			if (!stage) continue
			const branch = index === visibleRoles.length - 1 ? "└─" : "├─"
			const label = ROLE_LABELS[role]
			if (stage.status === "pending") {
				lines.push(theme.fg("dim", `  ${branch} ○ ${label}`))
			} else if (stage.status === "running") {
				lines.push(`  ${branch} ${theme.fg("accent", SPINNER[this.spinnerFrame] ?? SPINNER[0] ?? "•")} ${label}`)
			} else if (stage.status === "completed") {
				lines.push(
					`  ${branch} ${theme.fg("success", "✓")} ${label}${stage.durationMs === undefined ? "" : ` · ${formatDuration(stage.durationMs)}`}`,
				)
			} else {
				const reason = stage.reason ? SAFE_FAILURE_LABELS[stage.reason] : "unavailable"
				lines.push(
					`  ${branch} ${theme.fg("warning", "⚠")} ${label} · ${reason}${stage.durationMs === undefined ? "" : ` · ${formatDuration(stage.durationMs)}`}`,
				)
			}
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""))
	}
}
