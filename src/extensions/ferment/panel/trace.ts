import type { Theme } from "@earendil-works/pi-coding-agent"
import { FERMENT_EVENTS, type FermentEventChannel } from "../domain-events.js"
import { computeVisibleWindow, padText, truncateText } from "./layout.js"

export interface TraceEntry {
	ts: number
	kind: string
	text: string
}

const MAX_TRACE_ENTRIES = 200

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === "string" ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key]
	return typeof value === "number" ? value : undefined
}

export class FermentTrace {
	private entries: TraceEntry[] = []

	add(kind: string, text: string, ts = Date.now()): void {
		this.entries.push({ ts, kind, text })
		if (this.entries.length > MAX_TRACE_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_TRACE_ENTRIES)
		}
	}

	addDomainEvent(channel: FermentEventChannel, payload: unknown): void {
		const data = asRecord(payload)
		switch (channel) {
			case FERMENT_EVENTS.STARTED:
				this.add("start", stringField(data, "name") ?? "ferment started")
				return
			case FERMENT_EVENTS.COMPLETED:
				this.add("done", stringField(data, "name") ?? "ferment completed")
				return
			case FERMENT_EVENTS.ABANDONED:
				this.add("abandon", stringField(data, "name") ?? "ferment abandoned")
				return
			case FERMENT_EVENTS.PHASE_STARTED:
				this.add("phase", `${stringField(data, "phaseName") ?? "phase"} started`)
				return
			case FERMENT_EVENTS.PHASE_COMPLETED:
				this.add("phase", `${stringField(data, "phaseName") ?? "phase"} completed`)
				return
			case FERMENT_EVENTS.STEP_STARTED:
				this.add("step", `step ${numberField(data, "stepIndex") ?? "?"} started`)
				return
			case FERMENT_EVENTS.STEP_COMPLETED:
				this.add("step", `step ${numberField(data, "stepIndex") ?? "?"} completed`)
				return
			case FERMENT_EVENTS.STEP_FAILED:
				this.add("step", `step ${numberField(data, "stepIndex") ?? "?"} failed`)
				return
			case FERMENT_EVENTS.STEERING:
				this.add("steer", "human steering")
				return
		}
	}

	addToolCall(event: unknown): void {
		const data = asRecord(event)
		const toolName =
			stringField(data, "toolName") ?? stringField(data, "name") ?? stringField(asRecord(data.tool), "name")
		if (toolName) this.add("tool", toolName)
	}

	addToolResult(event: unknown): void {
		const data = asRecord(event)
		const toolName =
			stringField(data, "toolName") ?? stringField(data, "name") ?? stringField(asRecord(data.tool), "name")
		const exitCode = numberField(data, "exitCode") ?? numberField(asRecord(data.result), "exitCode")
		const suffix = exitCode === undefined ? "" : ` exit ${exitCode}`
		if (toolName || suffix) this.add("verify", `${toolName ?? "tool"}${suffix}`)
	}

	render(width: number, height: number, theme: Theme): string[] {
		const rows = Math.max(0, height)
		if (rows === 0) return []
		if (this.entries.length === 0) {
			return [
				theme.fg("dim", padText("no activity yet", width)),
				...Array.from({ length: rows - 1 }, () => " ".repeat(width)),
			]
		}
		const { start, end } = computeVisibleWindow(this.entries.length - 1, this.entries.length, rows)
		const visible = this.entries.slice(start, end)
		const lines = visible.map((entry) => {
			const time = new Date(entry.ts).toLocaleTimeString("en-US", {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
			const meta = `${time}  ${entry.kind.padEnd(7)}`
			const text = truncateText(entry.text, Math.max(0, width - meta.length))
			return padText(`${theme.fg("dim", meta)}${text}`, width)
		})
		while (lines.length < rows) lines.unshift(" ".repeat(width))
		return lines.slice(-rows)
	}
}
