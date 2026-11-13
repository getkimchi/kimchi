import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import { CURSOR_MARKER, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { mountInputPanel, safePanelText } from "../../components/input-panel.js"
import { buildAlignedLine } from "../../components/tool-block.js"
import { claimRawInputCapture } from "../shared-input.js"
import type { PRMonitor } from "./monitor.js"
import {
	prWatchFixesLabel,
	prWatchPhaseLabel,
	prWatchPlural,
	prWatchSummary,
	prWatchTargetLabel,
} from "./presentation.js"
import { PLAN_MODE_MESSAGE, type PRMonitorState } from "./types.js"

export class PRMonitorPanel {
	private state: PRMonitorState
	private offset = 0
	private width = 80
	private busy = false
	private error: string | undefined
	private disposed = false
	private readonly releaseInput = claimRawInputCapture()
	private readonly restoreRender: (() => void) | undefined
	private readonly unsubscribe: () => void
	private readonly timer: ReturnType<typeof setInterval>

	constructor(
		private readonly monitor: Pick<PRMonitor, "snapshot" | "observe" | "refresh" | "configure">,
		private readonly tui: { requestRender(): void; terminal: { rows: number } },
		private readonly done: () => void,
		private readonly theme: Theme,
	) {
		this.state = monitor.snapshot
		this.restoreRender = mountInputPanel(tui, (width) => this.renderContent(width))
		this.unsubscribe = monitor.observe((state) => {
			this.state = state
			this.tui.requestRender()
		})
		this.timer = setInterval(() => this.tui.requestRender(), 1000)
		this.timer.unref?.()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.releaseInput()
		this.restoreRender?.()
		this.unsubscribe()
		clearInterval(this.timer)
	}

	close(): void {
		if (this.disposed) return
		this.dispose()
		this.done()
	}

	invalidate(): void {}

	private get height(): number {
		return Math.max(1, Math.min(16, this.tui.terminal.rows - 3, this.body(this.width).length + 8))
	}

	private get pageRows(): number {
		return Math.max(0, this.height - 8)
	}

	private body(width: number): string[] {
		const lines: string[] = []
		const add = (text: string, color: ThemeColor = "text") => {
			lines.push(...wrapTextWithAnsi(safePanelText(text), width).map((line) => this.theme.fg(color, line)))
		}
		const pr = this.state.pullRequest
		const message = this.error ?? this.state.message
		if (message && message !== PLAN_MODE_MESSAGE) add(message, this.state.phase === "error" ? "error" : "warning")
		if (this.state.watches && this.state.watches.length > 1) {
			for (const { cwd, state } of this.state.watches) {
				const target = state.pullRequest
				add(
					`${target ? `${target.repository} ${prWatchTargetLabel(target)}` : cwd} · ${prWatchPhaseLabel(state)} · ${prWatchFixesLabel(state)}`,
				)
				add(prWatchSummary(state), "muted")
				if (state.message) add(state.message, "warning")
			}
			return lines
		}
		if (!pr) return lines
		for (const check of pr.checks.filter((check) => check.state === "failed" || check.state === "pending"))
			add(`${check.state}: ${check.name}`, check.state === "failed" ? "error" : "text")
		for (const feedback of pr.feedback) {
			add(
				`${feedback.author}${feedback.path ? ` · ${feedback.path}${feedback.line ? `:${feedback.line}` : ""}` : ""}${feedback.trusted ? "" : " · manual review"}`,
			)
			add(feedback.body.replace(/\s+/g, " ").slice(0, 300))
		}
		return lines
	}

	private async act(action: "refresh" | "pause" | "stop"): Promise<void> {
		if (this.busy || this.disposed) return
		this.busy = true
		this.error = undefined
		this.tui.requestRender()
		try {
			await (action === "refresh" ? this.monitor.refresh() : this.monitor.configure(action === "pause", false))
		} catch (error) {
			if (!this.disposed) this.error = error instanceof Error ? error.message : String(error)
		} finally {
			this.busy = false
			if (!this.disposed) this.tui.requestRender()
		}
	}

	handleInput(data: string): void {
		if (this.disposed) return
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.close()
			return
		}
		if (matchesKey(data, "r")) void this.act("refresh")
		else if (matchesKey(data, "p") && this.state.enabled && this.state.autoFix) void this.act("pause")
		else if (matchesKey(data, "s") && this.state.enabled) void this.act("stop")
		else {
			const max = Math.max(0, this.body(this.width).length - this.pageRows)
			const page = Math.max(1, this.pageRows)
			const delta = matchesKey(data, "pageUp")
				? -page
				: matchesKey(data, "pageDown")
					? page
					: matchesKey(data, "up")
						? -1
						: matchesKey(data, "down")
							? 1
							: 0
			this.offset = matchesKey(data, "home")
				? 0
				: matchesKey(data, "end")
					? max
					: Math.max(0, Math.min(max, this.offset + delta))
			this.tui.requestRender()
		}
	}

	render(width: number): string[] {
		const lines = this.renderContent(width)
		if (this.restoreRender) lines[0] = CURSOR_MARKER + lines[0]
		return lines
	}

	private renderContent(width: number): string[] {
		const theme = this.theme
		const w = Math.max(1, width)
		this.width = Math.max(1, w - 2)
		const content = this.body(this.width)
		if (w < 6 || this.height < 8 || (content.length > 0 && this.pageRows === 0))
			return [truncateToWidth(theme.fg("text", "Esc close · enlarge terminal to monitor"), w, "…", true)]
		this.offset = Math.max(0, Math.min(this.offset, content.length - this.pageRows))
		const state = this.state
		const heading =
			state.watches && state.watches.length > 1
				? `Monitor · ${state.watches.length} ${prWatchPlural(state)}`
				: state.pullRequest
					? `Monitor · ${prWatchTargetLabel(state.pullRequest)}`
					: "Monitor"
		const checked = state.checkedAt ? Date.parse(state.checkedAt) : Number.NaN
		const age = Number.isFinite(checked) ? `${Math.max(0, Math.floor((Date.now() - checked) / 1000))}s ago` : "not yet"
		const hint = (key: string, label = "") => theme.fg("accent", key) + (label ? theme.fg("text", ` ${label}`) : "")
		const controls = [
			hint("Esc", "close"),
			hint("R", this.width >= 62 ? "refresh" : ""),
			...(state.enabled && state.autoFix ? [hint("P", this.width >= 62 ? "pause fixes" : "pause")] : []),
			...(state.enabled ? [hint("S", "stop")] : []),
		]
		const lines = [
			buildAlignedLine(
				theme.bold(theme.fg("text", heading)),
				theme.fg(
					state.phase === "error" ? "error" : state.phase === "attention" ? "warning" : "text",
					prWatchPhaseLabel(state),
				),
				this.width,
			),
			theme.fg(
				"text",
				safePanelText(
					state.watches && state.watches.length > 1
						? "Local checkouts · one repair at a time"
						: (state.pullRequest?.title ?? "This branch"),
				),
			),
			theme.fg("text", prWatchSummary(state)),
			theme.fg(state.message === PLAN_MODE_MESSAGE ? "warning" : "text", prWatchFixesLabel(state)),
			...Array.from({ length: this.pageRows }, (_, i) => content[this.offset + i] ?? ""),
			theme.fg(
				"text",
				`${this.busy ? "Updating · " : ""}Checked ${age}${content.length > this.pageRows ? ` · ${this.offset + 1}–${Math.min(content.length, this.offset + this.pageRows)} of ${content.length} · ↑↓ scroll` : ""}`,
			),
			controls.join(theme.fg("dim", " · ")),
		]
		const border = theme.fg("borderMuted", "─".repeat(w))
		return [border, ...lines.map((line) => ` ${truncateToWidth(line, this.width, "…", true)} `), border]
	}
}
