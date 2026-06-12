import type { Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey } from "@earendil-works/pi-tui"
import type { FermentListItem } from "../../../ferment/store.js"
import type { Ferment } from "../../../ferment/types.js"
import { gradeColor } from "../colors.js"
import { phaseBarTone, segBar } from "./bars.js"
import { computeVisibleWindow, formatRelativeTime, padText, selectedLine, truncateText } from "./layout.js"

type HistoryFilter = "all" | "running" | "done" | "abandoned"

const FILTERS: HistoryFilter[] = ["all", "running", "done", "abandoned"]

export interface HistoryViewActions {
	requestRender(): void
	resume(id: string): void
	delete(id: string): void
}

export interface HistoryStorage {
	list(): FermentListItem[]
	get(id: string): Ferment | undefined
}

function matchesFilter(ferment: Ferment, filter: HistoryFilter): boolean {
	if (filter === "all") return true
	if (filter === "done") return ferment.status === "complete"
	if (filter === "abandoned") return ferment.status === "abandoned"
	return (
		ferment.status === "draft" ||
		ferment.status === "planned" ||
		ferment.status === "running" ||
		ferment.status === "paused"
	)
}

function doneSteps(ferment: Ferment): number {
	return ferment.phases.reduce(
		(total, phase) =>
			total +
			phase.steps.filter((step) => step.status === "done" || step.status === "verified" || step.status === "skipped")
				.length,
		0,
	)
}

function totalSteps(ferment: Ferment): number {
	return ferment.phases.reduce((total, phase) => total + phase.steps.length, 0)
}

function activePhaseIndex(ferment: Ferment): number {
	const index = ferment.phases.findIndex((phase) => phase.id === ferment.activePhaseId || phase.status === "active")
	if (index >= 0) return index + 1
	const completed = ferment.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
	return Math.min(ferment.phases.length, Math.max(1, completed))
}

function statusBullet(ferment: Ferment, theme: Theme): string {
	if (ferment.status === "complete") return theme.fg("success", "○")
	if (ferment.status === "abandoned") return theme.fg("muted", "●")
	if (ferment.status === "paused") return theme.fg("warning", "●")
	return theme.fg("accent", "●")
}

function statusMeta(ferment: Ferment): string {
	if (ferment.status === "complete") return `done · ${totalSteps(ferment)} steps`
	if (ferment.status === "abandoned") return `abandoned at phase ${activePhaseIndex(ferment)}`
	if (ferment.status === "paused")
		return `paused · phase ${activePhaseIndex(ferment)}/${Math.max(1, ferment.phases.length)}`
	return `phase ${activePhaseIndex(ferment)}/${Math.max(1, ferment.phases.length)} · ${ferment.status}`
}

function grade(ferment: Ferment): string {
	const g = ferment.grade?.grade
	return g ? gradeColor(g) : ""
}

export class HistoryView {
	private filter: HistoryFilter = "all"
	private selected = 0
	private query = ""
	private filtering = false
	private rows: Ferment[] = []

	constructor(
		private readonly storage: HistoryStorage,
		private readonly actions: HistoryViewActions,
	) {}

	refresh(): void {
		this.rows = this.storage
			.list()
			.map((item) => this.storage.get(item.id))
			.filter((ferment): ferment is Ferment => ferment !== undefined)
			.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.visibleRows().length - 1)))
	}

	private visibleRows(): Ferment[] {
		const q = this.query.trim().toLowerCase()
		return this.rows.filter((ferment) => {
			if (!matchesFilter(ferment, this.filter)) return false
			if (!q) return true
			return ferment.name.toLowerCase().includes(q) || ferment.id.toLowerCase().startsWith(q)
		})
	}

	private cycleFilter(direction: 1 | -1): void {
		const index = FILTERS.indexOf(this.filter)
		this.filter = FILTERS[(index + direction + FILTERS.length) % FILTERS.length] ?? "all"
		this.selected = 0
	}

	handleInput(data: string): boolean {
		if (this.filtering) {
			if (matchesKey(data, "escape")) {
				this.filtering = false
				return true
			}
			if (matchesKey(data, "return")) {
				this.filtering = false
				return true
			}
			if (matchesKey(data, "backspace") || data === "\x7f") {
				this.query = this.query.slice(0, -1)
				this.selected = 0
				return true
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.query += data
				this.selected = 0
				return true
			}
			return false
		}

		const rows = this.visibleRows()
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selected = Math.min(rows.length - 1, this.selected + 1)
			return true
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1)
			return true
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.cycleFilter(1)
			return true
		}
		if (matchesKey(data, "left")) {
			this.cycleFilter(-1)
			return true
		}
		if (matchesKey(data, "/")) {
			this.filtering = true
			return true
		}
		if (matchesKey(data, "return")) {
			const row = rows[this.selected]
			if (row) this.actions.resume(row.id)
			return true
		}
		if (matchesKey(data, "d")) {
			const row = rows[this.selected]
			if (row) this.actions.delete(row.id)
			return true
		}
		return false
	}

	render(width: number, height: number, theme: Theme): string[] {
		this.refresh()
		const rows = this.visibleRows()
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, rows.length - 1)))
		const lines: string[] = []
		const counts = {
			all: this.rows.length,
			running: this.rows.filter((row) => matchesFilter(row, "running")).length,
			done: this.rows.filter((row) => row.status === "complete").length,
			abandoned: this.rows.filter((row) => row.status === "abandoned").length,
		}
		const tabs = FILTERS.map((filter) => {
			const label = `${filter} ${counts[filter]}`
			return filter === this.filter ? theme.underline(theme.fg("accent", label)) : theme.fg("dim", label)
		}).join(theme.fg("muted", " · "))
		const filterText = this.query ? ` /${this.query}${this.filtering ? "█" : ""}` : this.filtering ? " /█" : ""
		lines.push(padText(`${tabs}${theme.fg("dim", filterText)}`, width))

		const bodyRows = Math.max(0, height - 1)
		const rowSlots = Math.max(1, Math.floor(bodyRows / 2))
		const { start, end } = computeVisibleWindow(this.selected, rows.length, rowSlots)
		if (rows.length === 0) {
			lines.push(theme.fg("dim", padText("no matching ferments", width)))
		} else {
			for (let i = start; i < end; i++) {
				const ferment = rows[i]
				if (!ferment) continue
				const selected = i === this.selected
				const branch = ferment.worktree.branch ?? "-"
				const age = formatRelativeTime(ferment.updatedAt ?? ferment.createdAt)
				const nameWidth = Math.max(10, width - branch.length - age.length - 9)
				const first = `${statusBullet(ferment, theme)}  ${truncateText(ferment.name, nameWidth)}  ${theme.fg("dim", branch)}  ${theme.fg("dim", age)}`
				const bar = segBar(doneSteps(ferment), totalSteps(ferment), 10, theme, phaseBarTone(ferment.status))
				const second = `   ${bar}  ${theme.fg("dim", statusMeta(ferment))}${grade(ferment) ? ` · ${grade(ferment)}` : ""}`
				lines.push(selected ? selectedLine(theme, first, width) : padText(first, width))
				lines.push(selected ? selectedLine(theme, second, width) : padText(second, width))
			}
		}
		while (lines.length < height) lines.push(" ".repeat(width))
		return lines.slice(0, height)
	}
}
