import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { claimRawInputCapture } from "../shared-input.js"
import { bashOutputAge, bashStatus, bashTitle, safeBashText } from "./bash-display.js"
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

	private get pageRows(): number {
		return Math.max(1, this.tui.terminal.rows - 10)
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
		const w = Math.max(1, width)
		const innerWidth = Math.max(1, w - 4)
		this.width = innerWidth
		const height = Math.max(1, this.tui.terminal.rows - 2)
		if (w < 6 || height < 9) return [truncateToWidth("Esc back · enlarge terminal to inspect", w, "…", true)]
		const fit = (lines: string[]) => [
			`╭${"─".repeat(w - 2)}╮`,
			...lines.slice(0, height - 2).map((line) => `│ ${truncateToWidth(line, innerWidth, "…", true)} │`),
			`╰${"─".repeat(w - 2)}╯`,
		]
		const now = Date.now()
		if (!this.detail || !this.selected) {
			const lines = [
				`Commands · this session · ${this.entries.filter((entry) => entry.state === "running").length} running`,
			]
			if (!this.entries.length) lines.push("No managed Bash commands running in this session")
			const current = this.entries.findIndex((entry) => entry.handle === this.selected?.handle)
			const count = Math.max(1, Math.floor((height - 4) / 2))
			const start = Math.max(0, current - count + 1)
			for (const entry of this.entries.slice(start, start + count)) {
				lines.push(
					`${entry.handle === this.selected?.handle ? ">" : " "} ${bashTitle(entry)} · ${bashStatus(entry, now)}`,
				)
				lines.push(`  ${safeBashText(entry.command).replace(/\s+/g, " ")} · ${bashOutputAge(entry, now)}`)
			}
			lines.push("Esc close · ↑↓ select · Enter inspect")
			return fit(lines)
		}
		const entry = this.selected
		const content = this.content(innerWidth)
		const maxOffset = Math.max(0, content.length - this.pageRows)
		const offset = this.tab === "Output" && this.follow ? maxOffset : Math.min(this.offset, maxOffset)
		const deadline =
			entry.state === "running" ? ` · auto-stop in ${Math.max(0, Math.ceil((entry.deadlineMs - now) / 1000))}s` : ""
		return fit([
			`${bashTitle(entry)} · ${bashStatus(entry, now)}`,
			`Command ${entry.handle} · cwd ${safeBashText(entry.cwd)}${deadline}`,
			`${this.tab === "Script" ? "[Script]  Output" : "Script  [Output]"}${this.tab === "Output" ? ` · Follow: ${this.follow ? "on" : "off (paused view)"}` : ""}`,
			...content.slice(offset, offset + this.pageRows),
			`${bashOutputAge(entry, now)}${entry.omittedBytes > 0 ? " · older output omitted" : ""}`,
			`Lines ${offset + 1}–${Math.min(content.length, offset + this.pageRows)} of ${content.length}`,
			innerWidth >= 62
				? "Esc back · Tab switch view · PgUp/PgDn scroll · End follow latest"
				: "Esc back · Tab · PgUp/PgDn · End",
		])
	}
}
