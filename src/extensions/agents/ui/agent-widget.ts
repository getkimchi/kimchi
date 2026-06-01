/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 */

import { truncateToWidth } from "@earendil-works/pi-tui"
import { remountTipWidget } from "../../tips/index.js"
import type { AgentManager } from "../manager/agent-manager.js"
import { type LifetimeUsage, type SessionLike, getLifetimeTotal, getSessionContextPercent } from "../manager/usage.js"
import { getConfig } from "../personas/agent-types.js"
import type { AgentAbortReason, SubagentType } from "../personas/types.js"

const MAX_WIDGET_LINES = 12

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"])

const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
}

export type Theme = {
	fg(color: string, text: string): string
	bold(text: string): string
}

export type UICtx = {
	setStatus(key: string, text: string | undefined): void
	setWidget(
		key: string,
		content: undefined | ((tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void
}

export interface AgentActivity {
	activeTools: Map<string, string>
	toolUses: number
	responseText: string
	session?: SessionLike
	turnCount: number
	maxTurns?: number
	lifetimeUsage: LifetimeUsage
}

export interface AgentDetails {
	displayName: string
	description: string
	subagentType: string
	toolUses: number
	tokens: string
	tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
	durationMs: number
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background"
	visibility?: "user" | "system"
	activity?: string
	spinnerFrame?: number
	modelName?: string
	tags?: string[]
	turnCount?: number
	maxTurns?: number
	agentId?: string
	sessionFile?: string
	error?: string
	abortReason?: AgentAbortReason
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`
	return `${count} token`
}

export function formatSessionTokens(tokens: number, percent: number | null, theme: Theme, compactions = 0): string {
	const tokenStr = formatTokens(tokens)
	const annot: string[] = []
	if (percent !== null) {
		const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim"
		annot.push(theme.fg(color, `${Math.round(percent)}%`))
	}
	if (compactions > 0) {
		annot.push(theme.fg("dim", `↻${compactions}`))
	}
	if (annot.length === 0) return tokenStr
	return `${tokenStr} (${annot.join(" · ")})`
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
	return maxTurns != null ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`
}

export function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`
}

export function formatDuration(startedAt: number, completedAt?: number): string {
	if (completedAt) return formatMs(completedAt - startedAt)
	return `${formatMs(Date.now() - startedAt)} (running)`
}

export function getDisplayName(type: SubagentType): string {
	return getConfig(type).displayName
}

function truncateLine(text: string, len = 60): string {
	const line =
		text
			.split("\n")
			.find((l) => l.trim())
			?.trim() ?? ""
	if (line.length <= len) return line
	return `${line.slice(0, len)}…`
}

export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
	if (activeTools.size > 0) {
		const groups = new Map<string, number>()
		for (const toolName of activeTools.values()) {
			const action = TOOL_DISPLAY[toolName] ?? toolName
			groups.set(action, (groups.get(action) ?? 0) + 1)
		}

		const parts: string[] = []
		for (const [action, count] of groups) {
			if (count > 1) {
				parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`)
			} else {
				parts.push(action)
			}
		}
		return `${parts.join(", ")}…`
	}

	if (responseText && responseText.trim().length > 0) {
		return truncateLine(responseText)
	}

	return "thinking…"
}

export class AgentWidget {
	private uiCtx: UICtx | undefined
	private widgetFrame = 0
	private widgetInterval: ReturnType<typeof setInterval> | undefined
	private finishedTurnAge = new Map<string, number>()
	private static readonly ERROR_LINGER_TURNS = 2

	private widgetRegistered = false
	private tui: unknown = undefined
	private lastStatusText: string | undefined

	constructor(
		private manager: AgentManager,
		private agentActivity: Map<string, AgentActivity>,
	) {}

	setUICtx(ctx: UICtx) {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx
			this.widgetRegistered = false
			this.tui = undefined
			this.lastStatusText = undefined
		}
	}

	onTurnStart() {
		for (const [id, age] of this.finishedTurnAge) {
			this.finishedTurnAge.set(id, age + 1)
		}
		this.update()
	}

	ensureTimer() {
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 80)
		}
	}

	private shouldShowFinished(agentId: string, status: string): boolean {
		const age = this.finishedTurnAge.get(agentId) ?? 0
		const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1
		return age < maxAge
	}

	markFinished(agentId: string) {
		if (!this.finishedTurnAge.has(agentId)) {
			this.finishedTurnAge.set(agentId, 0)
		}
	}

	private renderFinishedLine(
		a: {
			id: string
			type: SubagentType
			status: string
			description: string
			toolUses: number
			startedAt: number
			completedAt?: number
			error?: string
			abortReason?: AgentAbortReason
			modelId?: string
		},
		theme: Theme,
	): string {
		const name = getDisplayName(a.type)
		const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt)

		let icon: string
		let statusText: string
		if (a.status === "completed") {
			icon = theme.fg("success", "✓")
			statusText = ""
		} else if (a.status === "steered") {
			icon = theme.fg("warning", "✓")
			statusText = theme.fg("warning", " (turn limit)")
		} else if (a.status === "stopped") {
			icon = theme.fg("dim", "■")
			statusText = theme.fg("dim", " stopped")
		} else if (a.status === "error") {
			icon = theme.fg("error", "✗")
			const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : ""
			statusText = theme.fg("error", ` error${errMsg}`)
		} else {
			icon = theme.fg("error", "✗")
			const reason =
				a.abortReason === "token_budget" ? " (token budget)" : a.abortReason === "max_turns" ? " (max turns)" : ""
			statusText = theme.fg("warning", ` aborted${reason}`)
		}

		const parts: string[] = []
		const activity = this.agentActivity.get(a.id)
		if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns))
		if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`)
		parts.push(duration)

		const modelTag = a.modelId ? ` ${theme.fg("dim", `[${a.modelId}]`)}` : ""
		return `${icon} ${theme.fg("dim", name)}${modelTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const allAgents = this.manager.listAgents().filter((a) => a.visibility !== "system")
		const running = allAgents.filter((a) => a.status === "running")
		const queued = allAgents.filter((a) => a.status === "queued")
		const finished = allAgents.filter(
			(a) =>
				a.status !== "running" && a.status !== "queued" && a.completedAt && this.shouldShowFinished(a.id, a.status),
		)

		const hasActive = running.length > 0 || queued.length > 0
		const hasFinished = finished.length > 0

		if (!hasActive && !hasFinished) return []

		const truncate = (line: string) => truncateToWidth(line, width)
		const headingColor = hasActive ? "accent" : "dim"
		const headingIcon = hasActive ? "●" : "○"
		const frame = SPINNER[this.widgetFrame % SPINNER.length]

		const finishedLines: string[] = []
		for (const a of finished) {
			finishedLines.push(truncate(`${theme.fg("dim", "├─")} ${this.renderFinishedLine(a, theme)}`))
		}

		const runningLines: string[][] = []
		for (const a of running) {
			const name = getDisplayName(a.type)
			const elapsed = formatMs(Date.now() - a.startedAt)

			const bg = this.agentActivity.get(a.id)
			const toolUses = bg?.toolUses ?? a.toolUses
			const tokens = getLifetimeTotal(bg?.lifetimeUsage)
			const contextPercent = getSessionContextPercent(bg?.session)
			const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : ""

			const parts: string[] = []
			if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns))
			if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`)
			if (tokenText) parts.push(tokenText)
			parts.push(elapsed)
			const statsText = parts.join(" · ")

			const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…"

			const modelTag = a.modelId ? ` ${theme.fg("dim", `[${a.modelId}]`)}` : ""
			runningLines.push([
				truncate(
					`${theme.fg("dim", "├─")} ${theme.fg("accent", frame)} ${theme.bold(name)}${modelTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", statsText)}`,
				),
				truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
			])
		}

		const queuedLine =
			queued.length > 0
				? truncate(`${theme.fg("dim", "├─")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
				: undefined

		const maxBody = MAX_WIDGET_LINES - 1
		const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0)

		const lines: string[] = [truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`)]

		if (totalBody <= maxBody) {
			lines.push(...finishedLines)
			for (const pair of runningLines) lines.push(...pair)
			if (queuedLine) lines.push(queuedLine)

			if (lines.length > 1) {
				const last = lines.length - 1
				lines[last] = lines[last].replace("├─", "└─")
				if (runningLines.length > 0 && !queuedLine) {
					if (last >= 2) {
						lines[last - 1] = lines[last - 1].replace("├─", "└─")
						lines[last] = lines[last].replace("│  ", "   ")
					}
				}
			}
		} else {
			let budget = maxBody - 1
			let hiddenRunning = 0
			let hiddenFinished = 0

			for (const pair of runningLines) {
				if (budget >= 2) {
					lines.push(...pair)
					budget -= 2
				} else {
					hiddenRunning++
				}
			}

			if (queuedLine && budget >= 1) {
				lines.push(queuedLine)
				budget--
			}

			for (const fl of finishedLines) {
				if (budget >= 1) {
					lines.push(fl)
					budget--
				} else {
					hiddenFinished++
				}
			}

			const overflowParts: string[] = []
			if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`)
			if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`)
			const overflowText = overflowParts.join(", ")
			lines.push(
				truncate(
					`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`,
				),
			)
		}

		return lines
	}

	update() {
		if (!this.uiCtx) return
		const allAgents = this.manager.listAgents().filter((a) => a.visibility !== "system")

		let runningCount = 0
		let queuedCount = 0
		let hasFinished = false
		for (const a of allAgents) {
			if (a.status === "running") {
				runningCount++
			} else if (a.status === "queued") {
				queuedCount++
			} else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) {
				hasFinished = true
			}
		}
		const hasActive = runningCount > 0 || queuedCount > 0

		if (!hasActive && !hasFinished) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("agents", undefined)
				this.widgetRegistered = false
				this.tui = undefined
			}
			if (this.lastStatusText !== undefined) {
				this.uiCtx.setStatus("subagents", undefined)
				this.lastStatusText = undefined
			}
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval)
				this.widgetInterval = undefined
			}
			for (const [id] of this.finishedTurnAge) {
				if (!allAgents.some((a) => a.id === id)) this.finishedTurnAge.delete(id)
			}
			return
		}

		let newStatusText: string | undefined
		if (hasActive) {
			const statusParts: string[] = []
			if (runningCount > 0) statusParts.push(`${runningCount} running`)
			if (queuedCount > 0) statusParts.push(`${queuedCount} queued`)
			const total = runningCount + queuedCount
			newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`
		}
		if (newStatusText !== this.lastStatusText) {
			this.uiCtx.setStatus("subagents", newStatusText)
			this.lastStatusText = newStatusText
		}

		this.widgetFrame++

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"agents",
				(tui, theme) => {
					this.tui = tui
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false
							this.tui = undefined
						},
					}
				},
				{ placement: "aboveEditor" },
			)
			this.widgetRegistered = true
			// Re-insert tip widget after agents so it renders directly above the editor
			// (framework renders aboveEditor widgets in Map insertion order).
			remountTipWidget()
		} else {
			;(this.tui as { requestRender?(): void } | undefined)?.requestRender?.()
		}
	}

	dispose() {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval)
			this.widgetInterval = undefined
		}
		if (this.uiCtx) {
			this.uiCtx.setWidget("agents", undefined)
			this.uiCtx.setStatus("subagents", undefined)
		}
		this.widgetRegistered = false
		this.tui = undefined
		this.lastStatusText = undefined
	}
}
