import type { Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { claimRawInputCapture } from "../shared-input.js"
import { bashOutputAge, bashStatus, bashStatusColor, bashTitle, safeBashText } from "./bash-display.js"
import type { ProcessDisplaySnapshot, ProcessRegistry } from "./process-registry.js"

export class CommandsPanel {
	private entries: readonly ProcessDisplaySnapshot[] = []
	private selected: ProcessDisplaySnapshot | undefined
	private detail = false
	private tab: "Script" | "Output" = "Script"
	private offset = 0
	private follow = true
	private pausedOutput: string | undefined
	private width = 80
	private unsubscribe: (() => void) | undefined
	private timer: ReturnType<typeof setInterval> | undefined
	private disposed = false
	private readonly releaseInput = claimRawInputCapture()

	constructor(
		private readonly registry: ProcessRegistry | undefined,
		private readonly tui: { requestRender(): void; terminal: { rows: number } },
		private readonly done: () => void,
		private readonly theme: Theme,
	) {
		this.refresh()
		this.timer = setInterval(() => {
			this.refresh()
			this.tui.requestRender()
		}, 250)
		this.timer.unref?.()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.releaseInput()
		clearInterval(this.timer)
		this.unsubscribe?.()
	}

	close(): void {
		this.dispose()
		this.done()
	}

	invalidate(): void {}

	private get height(): number {
		const rows = this.tui.terminal.rows
		return Math.max(1, Math.min(rows - 4, Math.max(9, Math.floor(rows / 2))))
	}

	private get pageRows(): number {
		return Math.max(1, this.height - 7)
	}

	private content(width: number): string[] {
		const text =
			this.tab === "Script"
				? (this.selected?.command ?? "")
				: (this.pausedOutput ?? this.selected?.output) || "No output yet"
		return wrapTextWithAnsi(safeBashText(text), width)
	}

	private refresh(): void {
		this.entries = this.registry?.listDisplaySnapshots() ?? []
		if (!this.selected && this.entries[0]) this.select(this.entries[0])
		const current = this.entries.find((entry) => entry.handle === this.selected?.handle)
		if (current) this.selected = current
		// Only the selected terminal record survives registry removal, until the panel closes.
		if (this.selected && !current) this.entries = [...this.entries, this.selected]
	}

	private select(snapshot: ProcessDisplaySnapshot): void {
		this.unsubscribe?.()
		this.selected = snapshot
		this.unsubscribe = this.registry?.observeDisplay(snapshot.handle, (updated) => {
			this.selected = updated
			this.tui.requestRender()
		})
		this.offset = 0
		this.follow = true
		this.pausedOutput = undefined
	}

	handleInput(data: string): void {
		if (this.disposed) return
		const maxOffset = this.detail ? Math.max(0, this.content(this.width).length - this.pageRows) : 0
		const offset = this.tab === "Output" && this.follow ? maxOffset : Math.min(this.offset, maxOffset)
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			if (this.detail) this.detail = false
			else this.close()
		} else if (matchesKey(data, "ctrl+c")) {
			this.close()
		} else if (!this.detail) {
			const current = this.entries.findIndex((entry) => entry.handle === this.selected?.handle)
			const direction = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0
			const next = this.entries[Math.max(0, Math.min(this.entries.length - 1, current + direction))]
			if (direction && next) this.select(next)
			if (matchesKey(data, "enter") && this.selected) {
				this.detail = true
				this.tab = "Script"
				this.offset = 0
			}
		} else if (matchesKey(data, "tab")) {
			this.tab = this.tab === "Script" ? "Output" : "Script"
			this.offset = 0
			this.follow = true
			this.pausedOutput = undefined
		} else if (matchesKey(data, "end")) {
			this.follow = true
			this.pausedOutput = undefined
			this.offset = maxOffset
		} else {
			const delta = matchesKey(data, "pageUp")
				? -this.pageRows
				: matchesKey(data, "pageDown")
					? this.pageRows
					: matchesKey(data, "up")
						? -1
						: matchesKey(data, "down")
							? 1
							: 0
			if (delta || matchesKey(data, "home")) {
				if (this.tab === "Output" && this.follow) {
					this.pausedOutput = this.selected?.output
					this.follow = false
				}
				this.offset = matchesKey(data, "home") ? 0 : Math.max(0, Math.min(maxOffset, offset + delta))
			}
		}
		this.tui.requestRender()
	}

	render(width: number): string[] {
		const theme = this.theme
		const separator = theme.fg("dim", " · ")
		const hint = (key: string, label = "") => theme.fg("accent", key) + theme.fg("text", label ? ` ${label}` : "")
		const w = Math.max(1, width)
		const innerWidth = Math.max(1, w - 2)
		this.width = innerWidth
		const height = this.height
		if (w < 6 || height < 9) return [truncateToWidth(hint("Esc", "back · enlarge terminal to inspect"), w, "…", true)]
		const fit = (lines: string[]) => [
			theme.fg("accent", "─".repeat(w)),
			...lines.slice(0, height - 2).map((line) => ` ${truncateToWidth(line, innerWidth, "…", true)} `),
			theme.fg("accent", "─".repeat(w)),
		]
		const now = Date.now()
		if (!this.detail || !this.selected) {
			const lines = [
				`${theme.bold(theme.fg("accent", "Commands"))}${separator}${theme.fg("text", "this session")}${separator}${theme.fg("accent", `${this.entries.filter((entry) => entry.state === "running").length} running`)}`,
			]
			if (!this.entries.length) lines.push(theme.fg("text", "No managed Bash commands running in this session"))
			const current = this.entries.findIndex((entry) => entry.handle === this.selected?.handle)
			const count = Math.max(1, Math.floor((height - 4) / 2))
			const start = Math.max(0, current - count + 1)
			for (const entry of this.entries.slice(start, start + count)) {
				const selected = entry.handle === this.selected?.handle
				const title = theme.fg(selected ? "accent" : "text", `${selected ? "→" : " "} ${bashTitle(entry)}`)
				lines.push(
					`${selected ? theme.bold(title) : title}${separator}${theme.fg(bashStatusColor(entry), bashStatus(entry, now))}`,
				)
				lines.push(
					`  ${theme.fg("mdCode", safeBashText(entry.command).replace(/\s+/g, " "))}${separator}${theme.fg("text", bashOutputAge(entry, now))}`,
				)
			}
			lines.push([hint("Esc", "close"), hint("↑↓", "select"), hint("Enter", "inspect")].join(separator))
			return fit(lines)
		}
		const entry = this.selected
		const content = this.content(innerWidth)
		const maxOffset = Math.max(0, content.length - this.pageRows)
		const offset = this.tab === "Output" && this.follow ? maxOffset : Math.min(this.offset, maxOffset)
		const deadline =
			entry.state === "running" ? ` · auto-stop in ${Math.max(0, Math.ceil((entry.deadlineMs - now) / 1000))}s` : ""
		const tab = (label: "Script" | "Output") =>
			label === this.tab
				? theme.bg("selectedBg", theme.bold(theme.fg("accent", `[${label}]`)))
				: theme.fg("text", label)
		return fit([
			`${theme.bold(theme.fg("text", bashTitle(entry)))}${separator}${theme.fg(bashStatusColor(entry), bashStatus(entry, now))}`,
			theme.fg("text", `Command ${entry.handle} · cwd ${safeBashText(entry.cwd)}${deadline}`),
			`${tab("Script")}  ${tab("Output")}${this.tab === "Output" ? `${separator}${theme.fg(this.follow ? "success" : "warning", `Follow: ${this.follow ? "on" : "off (paused view)"}`)}` : ""}`,
			...content
				.slice(offset, offset + this.pageRows)
				.map((line) => theme.fg(this.tab === "Script" ? "mdCode" : "toolOutput", line)),
			`${theme.fg("text", `Lines ${offset + 1}–${Math.min(content.length, offset + this.pageRows)} of ${content.length}`)}${separator}${theme.fg("text", bashOutputAge(entry, now))}${entry.omittedBytes > 0 ? separator + theme.fg("warning", "older output omitted") : ""}`,
			innerWidth >= 62
				? [
						hint("Esc", "back"),
						hint("Tab", "switch view"),
						hint("PgUp/PgDn", "scroll"),
						hint("End", "follow latest"),
					].join(separator)
				: [hint("Esc", "back"), hint("Tab"), hint("PgUp/PgDn"), hint("End")].join(separator),
		])
	}
}
