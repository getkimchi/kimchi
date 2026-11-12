import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import { CURSOR_MARKER, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { mountInputPanel, safePanelText } from "../../components/input-panel.js"
import { claimRawInputCapture } from "../shared-input.js"
import type { PRMonitor } from "./monitor.js"
import type { PRMonitorState } from "./types.js"

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
		private readonly monitor: PRMonitor,
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
		return Math.max(1, Math.min(16, this.tui.terminal.rows - 4, Math.floor(this.tui.terminal.rows / 2)))
	}

	private get pageRows(): number {
		return Math.max(1, this.height - 6)
	}

	private body(width: number): string[] {
		const lines: string[] = []
		const add = (text: string, color: ThemeColor = "text") => {
			lines.push(...wrapTextWithAnsi(safePanelText(text), width).map((line) => this.theme.fg(color, line)))
		}
		const pr = this.state.pullRequest
		if (pr) {
			add(pr.title)
			add(`${pr.branch} · ${pr.headSha.slice(0, 8)}`)
			add(pr.url)
		} else
			add(
				this.state.phase === "error"
					? "PR data is unavailable."
					: this.state.enabled
						? "Watching this branch; no PR found yet."
						: "Watching is off.",
			)
		const message = this.error ?? this.state.message
		if (message) add(message, "warning")
		if (!pr) return lines
		const checks = pr.checks
		add(
			`CI${this.state.phase === "error" || !this.state.enabled ? " (last known)" : ""}: ${checks.filter((check) => check.state === "failed").length} failing, ${checks.filter((check) => check.state === "pending").length} running, ${checks.filter((check) => check.state === "passed").length} passed`,
			"accent",
		)
		if (!checks.length) add("No CI checks reported; result unknown.", "warning")
		for (const check of checks)
			add(
				`${check.state}: ${check.name}`,
				check.state === "failed" ? "error" : check.state === "passed" ? "success" : "text",
			)
		add(`Unresolved review threads: ${pr.feedback.length}`, "accent")
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
			const delta = matchesKey(data, "pageUp")
				? -this.pageRows
				: matchesKey(data, "pageDown")
					? this.pageRows
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
		if (w < 6 || this.height < 8)
			return [truncateToWidth(theme.fg("text", "Esc close · enlarge terminal to monitor"), w, "…", true)]
		const content = this.body(this.width)
		this.offset = Math.max(0, Math.min(this.offset, content.length - this.pageRows))
		const state = this.state
		const heading = `${state.pullRequest ? `PR #${state.pullRequest.number}` : "PR watch"} · ${state.enabled ? state.phase : "stopped"} · auto-fix ${state.autoFix ? "on" : "off"}`
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
			theme.bold(
				theme.fg(
					state.phase === "error" ? "error" : state.phase === "attention" ? "warning" : "accent",
					safePanelText(heading),
				),
			),
			theme.bg("selectedBg", theme.bold(theme.fg("accent", "[Monitor]"))),
			...Array.from({ length: this.pageRows }, (_, i) => content[this.offset + i] ?? ""),
			theme.fg(
				"text",
				`${this.busy ? "Updating · " : ""}Last checked ${age} · ${this.offset + 1}–${Math.min(content.length, this.offset + this.pageRows)} of ${content.length} · ↑↓/PgUp/PgDn scroll`,
			),
			controls.join(theme.fg("dim", " · ")),
		]
		const border = theme.fg("accent", "─".repeat(w))
		return [border, ...lines.map((line) => ` ${truncateToWidth(line, this.width, "…", true)} `), border]
	}
}
