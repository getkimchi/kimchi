import type { Theme } from "@earendil-works/pi-coding-agent"

export type BarTone = "running" | "done" | "pending" | "abandoned" | "failed"

const FILLED = "■"
const EMPTY = "□"

function toneColor(tone: BarTone): "accent" | "success" | "dim" | "muted" | "error" {
	switch (tone) {
		case "done":
			return "success"
		case "abandoned":
			return "muted"
		case "failed":
			return "error"
		case "pending":
			return "dim"
		case "running":
			return "accent"
	}
}

export function segBar(done: number, total: number, width: number, theme: Theme, tone: BarTone = "running"): string {
	const segments = Math.max(1, Math.floor(width))
	const boundedTotal = Math.max(0, total)
	const boundedDone = Math.max(0, Math.min(done, boundedTotal))
	const filled = boundedTotal === 0 ? 0 : Math.round((boundedDone / boundedTotal) * segments)
	const fill = theme.fg(toneColor(tone), FILLED.repeat(Math.min(segments, filled)))
	const empty = theme.fg("dim", EMPTY.repeat(Math.max(0, segments - filled)))
	return `${fill}${empty}`
}

export function phaseBarTone(status: string): BarTone {
	if (status === "completed" || status === "complete") return "done"
	if (status === "failed") return "failed"
	if (status === "skipped" || status === "abandoned") return "abandoned"
	if (status === "planned" || status === "pending") return "pending"
	return "running"
}
