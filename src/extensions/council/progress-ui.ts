import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type {
	CouncilProgressEvent,
	CouncilRole,
	CouncilTransactionProgressPhase,
	ReviewerRole,
	SafeCouncilFailureReason,
} from "./types.js"

export const COUNCIL_PROGRESS_WIDGET_KEY = "council-progress"

const STATUS_KEY = "council"
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const ROLE_ORDER: CouncilRole[] = ["lead", "independent", "critic", "checker", "judge", "repair", "revision"]
const ROLE_LABELS: Record<CouncilRole, string> = {
	lead: "drafting",
	independent: "independent",
	critic: "critic",
	checker: "checker",
	judge: "adjudicating",
	repair: "validating review",
	revision: "revising",
}
const TRANSACTION_PHASE_LABELS: Record<CouncilTransactionProgressPhase, string> = {
	preparing_candidate: "preparing candidate",
	validating_patch: "validating patch",
	reviewing: "reviewing",
	adjudicating: "adjudicating",
	revising: "revising",
	applying: "applying",
}
const PRESET_REVIEWERS: Record<"fast" | "normal" | "deep", readonly ReviewerRole[]> = {
	fast: ["critic"],
	normal: ["independent", "critic", "checker"],
	deep: ["independent", "critic", "checker"],
}
const SAFE_FAILURE_LABELS: Record<SafeCouncilFailureReason, string> = {
	cancelled: "cancelled",
	timed_out: "timed out",
	review_unavailable: "review unavailable",
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
	if (event.agreement) parts.push(`${event.agreement} agreement`)
	parts.push(formatDuration(event.durationMs))
	const cost = formatCost(event.estimatedCostUsd)
	if (cost) parts.push(cost)
	return parts.join(" · ")
}

function failedSummary(event: Extract<CouncilProgressEvent, { type: "run_failed" | "run_aborted" }>): string {
	if (event.type === "run_aborted") return `⚠ Council · cancelled · ${formatDuration(event.durationMs)}`
	return `✗ Council · could not safely finalize · ${SAFE_FAILURE_LABELS[event.reason]} · ${formatDuration(event.durationMs)}`
}

export class CouncilProgressUI {
	private activeRunId: string | undefined
	private lastStartedAt = Number.NEGATIVE_INFINITY
	private seenRunIds = new Set<string>()
	private reviewerRoles: readonly ReviewerRole[] = []
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
		this.reviewerRoles = []
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
		this.reviewerRoles = []
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
		this.reviewerRoles = PRESET_REVIEWERS[event.preset]
		this.stages.set("lead", { status: "pending" })
		for (const role of this.reviewerRoles) this.stages.set(role, { status: "pending" })
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
		const completedReviewers = this.reviewerRoles.filter((role) => {
			const status = this.stages.get(role)?.status
			return status === "completed" || status === "failed"
		}).length
		const reviewing = this.reviewerRoles.some((role) => this.stages.get(role)?.status !== "pending")
		const headline = this.transactionPhase
			? TRANSACTION_PHASE_LABELS[this.transactionPhase]
			: runningRoles.includes("revision")
				? "revising"
				: runningRoles.includes("repair")
					? "validating review"
					: runningRoles.includes("judge")
						? "adjudicating"
						: reviewing
							? completedReviewers === 0
								? "reviewing"
								: `reviewing ${completedReviewers}/${this.reviewerRoles.length}`
							: runningRoles.includes("lead")
								? "drafting"
								: "drafting"
		const spinner = theme.fg("accent", SPINNER[this.spinnerFrame] ?? SPINNER[0] ?? "•")
		const lines = [theme.bold(`${spinner} Council · ${headline}`)]
		const visibleRoles = ROLE_ORDER.filter((role) => {
			if (role === "lead" || role === "revision") return false
			if (role === "judge" || role === "repair") return this.stages.has(role)
			return this.reviewerRoles.includes(role as ReviewerRole)
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
