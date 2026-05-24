/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import type { AgentRecord } from "../personas/types.js"
import { extractText } from "../prompt/context.js"

// Expand tabs so visibleWidth() (which counts a tab as 1) matches what the
// terminal actually renders (8 columns). Without this, lines with embedded
// tabs (common in grep output) overflow the layout box and crash the renderer.
function expandTabs(s: string): string {
	return s.replace(/\t/g, "        ")
}
import { getLifetimeTotal, getSessionContextPercent } from "../manager/usage.js"
import type { Theme } from "./agent-widget.js"
import {
	type AgentActivity,
	describeActivity,
	formatDuration,
	formatSessionTokens,
	getDisplayName,
} from "./agent-widget.js"

const CHROME_LINES = 6
const MIN_VIEWPORT = 3

export class ConversationViewer implements Component {
	private scrollOffset = 0
	private autoScroll = true
	private unsubscribe: (() => void) | undefined
	private lastInnerW = 0
	private closed = false

	constructor(
		private tui: TUI,
		private session: AgentSession,
		private record: AgentRecord,
		private activity: AgentActivity | undefined,
		private theme: Theme,
		private done: (result: undefined) => void,
	) {
		this.unsubscribe = session.subscribe(() => {
			if (this.closed) return
			this.tui.requestRender()
		})
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true
			this.done(undefined)
			return
		}

		const totalLines = this.buildContentLines(this.lastInnerW).length
		const viewportHeight = this.viewportHeight()
		const maxScroll = Math.max(0, totalLines - viewportHeight)

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight)
			this.autoScroll = false
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight)
			this.autoScroll = this.scrollOffset >= maxScroll
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0
			this.autoScroll = false
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll
			this.autoScroll = true
		}
	}

	render(width: number): string[] {
		if (width < 6) return []
		const th = this.theme
		const innerW = width - 4
		this.lastInnerW = innerW
		const lines: string[] = []

		const pad = (s: string, len: number) => {
			const expanded = expandTabs(s)
			const vis = visibleWidth(expanded)
			return expanded + " ".repeat(Math.max(0, len - vis))
		}
		const row = (content: string) =>
			`${th.fg("border", "│")} ${truncateToWidth(pad(content, innerW), innerW)} ${th.fg("border", "│")}`
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`)
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`)
		const hrMid = row(th.fg("dim", "─".repeat(innerW)))

		lines.push(hrTop)
		const name = getDisplayName(this.record.type)
		const statusIcon =
			this.record.status === "running"
				? th.fg("accent", "●")
				: this.record.status === "completed"
					? th.fg("success", "✓")
					: this.record.status === "error"
						? th.fg("error", "✗")
						: th.fg("dim", "○")
		const duration = formatDuration(this.record.startedAt, this.record.completedAt)

		const headerParts: string[] = [duration]
		const toolUses = this.activity?.toolUses ?? this.record.toolUses
		if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`)
		const tokens = getLifetimeTotal(this.activity?.lifetimeUsage)
		if (tokens > 0) {
			const percent = getSessionContextPercent(this.activity?.session)
			headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount))
		}

		lines.push(
			row(
				`${statusIcon} ${th.bold(name)}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
			),
		)
		lines.push(hrMid)

		const contentLines = this.buildContentLines(innerW)
		const viewportHeight = this.viewportHeight()
		const maxScroll = Math.max(0, contentLines.length - viewportHeight)

		if (this.autoScroll) {
			this.scrollOffset = maxScroll
		}

		const visibleStart = Math.min(this.scrollOffset, maxScroll)
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight)

		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""))
		}

		lines.push(hrMid)
		const scrollPct =
			contentLines.length <= viewportHeight
				? "100%"
				: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`
		const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`)
		const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close")
		const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight))
		lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight))
		lines.push(hrBot)

		// statusIcon used for rendering — mark as intentionally referenced
		void statusIcon

		return lines
	}

	invalidate(): void {
		/* no cached state to clear */
	}

	dispose(): void {
		this.closed = true
		if (this.unsubscribe) {
			this.unsubscribe()
			this.unsubscribe = undefined
		}
	}

	private viewportHeight(): number {
		return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES)
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return []

		const th = this.theme
		const messages = this.session.messages
		const lines: string[] = []

		if (messages.length === 0) {
			lines.push(th.fg("dim", "(waiting for first message...)"))
			return lines
		}

		let needsSeparator = false
		for (const msg of messages) {
			if (msg.role === "user") {
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content)
				if (!text.trim()) continue
				if (needsSeparator) lines.push(th.fg("dim", "───"))
				lines.push(th.fg("accent", "[User]"))
				for (const line of wrapTextWithAnsi(text.trim(), width)) {
					lines.push(line)
				}
			} else if (msg.role === "assistant") {
				const textParts: string[] = []
				const toolCalls: string[] = []
				for (const c of msg.content) {
					if (c.type === "text" && c.text) textParts.push(c.text)
					else if (c.type === "toolCall") {
						toolCalls.push(
							(c as unknown as { name?: string; toolName?: string }).name ??
								(c as unknown as { name?: string; toolName?: string }).toolName ??
								"unknown",
						)
					}
				}
				if (needsSeparator) lines.push(th.fg("dim", "───"))
				lines.push(th.bold("[Assistant]"))
				if (textParts.length > 0) {
					for (const line of wrapTextWithAnsi(expandTabs(textParts.join("\n").trim()), width)) {
						lines.push(line)
					}
				}
				for (const name of toolCalls) {
					lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width))
				}
			} else if (msg.role === "toolResult") {
				const text = extractText(msg.content)
				const truncated = text.length > 500 ? `${text.slice(0, 500)}... (truncated)` : text
				if (!truncated.trim()) continue
				if (needsSeparator) lines.push(th.fg("dim", "───"))
				lines.push(th.fg("dim", "[Result]"))
				for (const line of wrapTextWithAnsi(expandTabs(truncated.trim()), width)) {
					lines.push(th.fg("dim", line))
				}
			} else if ((msg as unknown as { role: string }).role === "bashExecution") {
				const bash = msg as unknown as { command: string; output?: string }
				if (needsSeparator) lines.push(th.fg("dim", "───"))
				lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width))
				if (bash.output?.trim()) {
					const out = bash.output.length > 500 ? `${bash.output.slice(0, 500)}... (truncated)` : bash.output
					for (const line of wrapTextWithAnsi(expandTabs(out.trim()), width)) {
						lines.push(th.fg("dim", line))
					}
				}
			} else {
				continue
			}
			needsSeparator = true
		}

		if (this.record.status === "running" && this.activity) {
			const act = describeActivity(this.activity.activeTools, this.activity.responseText)
			lines.push("")
			lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width))
		}

		return lines.map((l) => truncateToWidth(l, width))
	}
}
