import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import { CURSOR_MARKER, type KeyId, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { mountInputPanel, safePanelText } from "../../components/input-panel.js"
import { buildAlignedLine } from "../../components/tool-block.js"
import { claimRawInputCapture } from "../shared-input.js"
import { ciSummary, fixesLabel, overview, phaseLabel, targetName, words } from "./presentation.js"
import type { PRWatchState } from "./types.js"
import type { PRWatcher } from "./watcher.js"

const MAX_HEIGHT = 16
const CHROME_ROWS = 6
const RESERVED_TERMINAL_ROWS = 3
const MIN_WIDTH = 6
const LABEL_MIN_WIDTH = 62
const FEEDBACK_PREVIEW = 300
const REDRAW_MS = 1000

/** The Monitor tab: every watched PR's checks and feedback over the input row. */
export class PRWatchPanel {
	private state: PRWatchState
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
		private readonly watcher: Pick<PRWatcher, "snapshot" | "observe" | "refresh" | "pause" | "stop">,
		private readonly tui: { requestRender(): void; terminal: { rows: number } },
		private readonly done: () => void,
		private readonly theme: Theme,
	) {
		this.state = watcher.snapshot
		this.restoreRender = mountInputPanel(tui, (width) => this.renderContent(width))
		this.unsubscribe = watcher.observe((state) => {
			this.state = state
			this.tui.requestRender()
		})
		this.timer = setInterval(() => this.tui.requestRender(), REDRAW_MS)
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

	private get watched() {
		return this.state.targets.filter((target) => target.enabled)
	}

	private get height(): number {
		return Math.max(
			1,
			Math.min(MAX_HEIGHT, this.tui.terminal.rows - RESERVED_TERMINAL_ROWS, this.body(this.width).length + CHROME_ROWS),
		)
	}

	private get pageRows(): number {
		return Math.max(0, this.height - CHROME_ROWS)
	}

	private body(width: number): string[] {
		const lines: string[] = []
		const add = (text: string, color: ThemeColor = "text") => {
			lines.push(...wrapTextWithAnsi(safePanelText(text), width).map((line) => this.theme.fg(color, line)))
		}
		const message = this.error ?? this.state.message
		if (message) add(message, "warning")
		for (const target of this.state.targets) {
			add(`${targetName(target)} · ${phaseLabel(target)} · ${fixesLabel(target)}`)
			add(ciSummary(target), "muted")
			if (target.message) add(target.message, target.phase === "error" ? "error" : "warning")
			for (const check of target.pullRequest?.checks ?? [])
				if (check.state === "failed" || check.state === "pending")
					add(`${check.state}: ${check.name}`, check.state === "failed" ? "error" : "text")
			for (const feedback of target.pullRequest?.feedback ?? []) {
				const place = feedback.path ? ` · ${feedback.path}${feedback.line ? `:${feedback.line}` : ""}` : ""
				add(`${feedback.author}${place}${feedback.trusted ? "" : " · manual review"}`)
				add(words(feedback.body).join(" ").slice(0, FEEDBACK_PREVIEW))
			}
		}
		return lines
	}

	private async act(action: "refresh" | "pause" | "stop"): Promise<void> {
		if (this.busy || this.disposed) return
		this.busy = true
		this.error = undefined
		this.tui.requestRender()
		try {
			await (action === "refresh"
				? this.watcher.refresh()
				: action === "pause"
					? this.watcher.pause()
					: this.watcher.stop())
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
		const watched = this.watched
		if (matchesKey(data, "r")) void this.act("refresh")
		else if (matchesKey(data, "p") && watched.some((target) => target.autoFix)) void this.act("pause")
		else if (matchesKey(data, "s") && watched.length) void this.act("stop")
		else this.scroll(data)
	}

	private scroll(data: string): void {
		const max = Math.max(0, this.body(this.width).length - this.pageRows)
		const page = Math.max(1, this.pageRows)
		const steps: [KeyId, number][] = [
			["pageUp", -page],
			["pageDown", page],
			["up", -1],
			["down", 1],
			["home", -max],
			["end", max],
		]
		const step = steps.find(([key]) => matchesKey(data, key))?.[1] ?? 0
		this.offset = Math.max(0, Math.min(max, this.offset + step))
		this.tui.requestRender()
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
		if (w < MIN_WIDTH || this.height < CHROME_ROWS || (content.length > 0 && this.pageRows === 0))
			return [truncateToWidth(theme.fg("text", "Esc close · enlarge terminal to monitor"), w, "…", true)]
		this.offset = Math.max(0, Math.min(this.offset, content.length - this.pageRows))
		const summary = overview(this.state)
		const checkedAt = Math.max(
			0,
			...this.watched.map((target) => (target.checkedAt ? Date.parse(target.checkedAt) : 0)),
		)
		const age = checkedAt ? `${Math.max(0, Math.floor((Date.now() - checkedAt) / 1000))}s ago` : "not yet"
		const wide = this.width >= LABEL_MIN_WIDTH
		const hint = (key: string, label = "") => theme.fg("accent", key) + (label ? theme.fg("text", ` ${label}`) : "")
		const controls = [
			hint("Esc", "close"),
			hint("R", wide ? "refresh" : ""),
			...(this.watched.some((target) => target.autoFix) ? [hint("P", wide ? "pause fixes" : "pause")] : []),
			...(this.watched.length ? [hint("S", "stop")] : []),
		]
		const scrolled =
			content.length > this.pageRows
				? ` · ${this.offset + 1}–${Math.min(content.length, this.offset + this.pageRows)} of ${content.length} · ↑↓ scroll`
				: ""
		const lines = [
			buildAlignedLine(
				theme.bold(theme.fg("text", summary ? `Monitor · ${summary.label}` : "Monitor")),
				theme.fg(summary?.tone ?? "text", summary?.phase ?? "Stopped"),
				this.width,
			),
			theme.fg("text", summary ? `${summary.summary} · ${summary.fixes}` : "Not watching"),
			...Array.from({ length: this.pageRows }, (_, i) => content[this.offset + i] ?? ""),
			theme.fg("text", `${this.busy ? "Updating · " : ""}Checked ${age}${scrolled}`),
			controls.join(theme.fg("dim", " · ")),
		]
		const border = theme.fg("borderMuted", "─".repeat(w))
		return [border, ...lines.map((line) => ` ${truncateToWidth(line, this.width, "…", true)} `), border]
	}
}
