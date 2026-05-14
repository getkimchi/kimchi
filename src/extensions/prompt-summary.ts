import type { AssistantMessage, Usage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { formatCount } from "./format.js"
import { isSubagent } from "./orchestration/prompt-transformer/prompt-transformer.js"

interface UsageTotals {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

interface SubagentStats {
	tokenUsage: {
		input: number
		output: number
		cacheRead: number
		cacheWrite: number
	}
}

interface PromptSummaryData {
	elapsed: string
	orchestrator: UsageTotals | null
	subagents: UsageTotals | null
	total: UsageTotals
	extras?: string[]
}

const pendingExtras: string[] = []

export function addPromptSummaryExtra(text: string): void {
	pendingExtras.push(text)
}

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function addUsage(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input
	totals.output += usage.output
	totals.cacheRead += usage.cacheRead
	totals.cacheWrite += usage.cacheWrite
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const s = ms / 1000
	if (s < 60) return `${s.toFixed(1)}s`
	const m = Math.floor(s / 60)
	const rem = Math.round(s % 60)
	return `${m}m ${rem}s`
}

const COL_GAP = "  "
const LABEL_WIDTH = 16
const INDENT = "  "

function usageRawCols(totals: UsageTotals): string[] {
	const cols = [`↑${formatCount(totals.input)}`, `↓${formatCount(totals.output)}`]
	if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
		cols.push(`cache-read ${formatCount(totals.cacheRead)}`)
		cols.push(`cache-write ${formatCount(totals.cacheWrite)}`)
	}
	return cols
}

function formatUsageRows(rows: Array<{ label: string; totals: UsageTotals }>, theme: Theme): string[] {
	const colSets = rows.map((r) => usageRawCols(r.totals))
	const colCount = Math.max(...colSets.map((c) => c.length))
	const colWidths = Array.from({ length: colCount }, (_, i) => Math.max(...colSets.map((c) => (c[i] ?? "").length)))

	return rows.map((row, ri) => {
		const cols = colSets[ri]
		const padded = colWidths.map((width, i) => (cols[i] ?? "").padEnd(width))
		const values = padded.join(COL_GAP)
		return INDENT + theme.fg("dim", row.label.padEnd(LABEL_WIDTH)) + values
	})
}

const promptSummaryRenderer: MessageRenderer<PromptSummaryData> = (message, _options, theme) => {
	const data = message.details as PromptSummaryData
	if (!data) return undefined

	const container = new Container()

	const dash = theme.fg("dim", "- ")
	const header = theme.bold(theme.fg("toolTitle", "Prompt summary"))
	container.addChild(new Text(dash + header, 0, 0))

	container.addChild(new Text(INDENT + theme.fg("dim", "execution".padEnd(LABEL_WIDTH)) + data.elapsed, 0, 0))

	if (!data.subagents) {
		// No subagents — single compact "tokens" row
		const t = data.total
		let values = `↑${formatCount(t.input)}${COL_GAP}↓${formatCount(t.output)}`
		if (t.cacheRead > 0 || t.cacheWrite > 0) {
			values += `${COL_GAP}cache-read ${formatCount(t.cacheRead)}${COL_GAP}cache-write ${formatCount(t.cacheWrite)}`
		}
		container.addChild(new Text(INDENT + theme.fg("dim", "tokens".padEnd(LABEL_WIDTH)) + values, 0, 0))
	} else {
		// Multi-row breakdown when subagents were involved
		const rows: Array<{ label: string; totals: UsageTotals }> = []
		if (data.orchestrator) rows.push({ label: "main model:", totals: data.orchestrator })
		rows.push({ label: "subagents:", totals: data.subagents })
		rows.push({ label: "total:", totals: data.total })

		for (const line of formatUsageRows(rows, theme)) {
			container.addChild(new Text(line, 0, 0))
		}
	}

	for (const extra of data.extras ?? []) {
		container.addChild(new Text(INDENT + theme.fg("dim", "note:".padEnd(LABEL_WIDTH)) + extra, 0, 0))
	}

	return container
}

export default function promptSummaryExtension(pi: ExtensionAPI) {
	if (isSubagent()) return

	pi.registerMessageRenderer("prompt-summary", promptSummaryRenderer)

	const orchestrator = emptyTotals()
	const subagents = emptyTotals()
	let startedAt = Date.now()

	pi.on("agent_start", () => {
		Object.assign(orchestrator, emptyTotals())
		Object.assign(subagents, emptyTotals())
		startedAt = Date.now()
	})

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage
		if (message.role !== "assistant") return
		addUsage(orchestrator, message.usage)
	})

	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return
		const stats = event.details as SubagentStats | undefined
		if (!stats?.tokenUsage) return
		subagents.input += stats.tokenUsage.input
		subagents.output += stats.tokenUsage.output
		subagents.cacheRead += stats.tokenUsage.cacheRead
		subagents.cacheWrite += stats.tokenUsage.cacheWrite
	})

	pi.on("agent_end", async () => {
		const grandTotal: UsageTotals = {
			input: orchestrator.input + subagents.input,
			output: orchestrator.output + subagents.output,
			cacheRead: orchestrator.cacheRead + subagents.cacheRead,
			cacheWrite: orchestrator.cacheWrite + subagents.cacheWrite,
		}
		if (grandTotal.input + grandTotal.output === 0) return

		const extras = pendingExtras.splice(0)

		const data: PromptSummaryData = {
			elapsed: formatDuration(Date.now() - startedAt),
			orchestrator: orchestrator.input + orchestrator.output > 0 ? { ...orchestrator } : null,
			subagents: subagents.input + subagents.output > 0 ? { ...subagents } : null,
			total: grandTotal,
			extras: extras.length > 0 ? extras : undefined,
		}

		// Defer so the agent event loop finishes and isStreaming resets to false
		// before sendMessage is called — otherwise it gets queued as a steer message
		// and only appears after the next user prompt.
		await new Promise((resolve) => setTimeout(resolve, 0))

		pi.sendMessage({
			customType: "prompt-summary",
			// Wrap in a tag so the LLM treats this as a system annotation, not user input.
			// All custom messages are transformed to role:"user" by pi-mono, so without
			// this the model interprets "Prompt summary (Xs)" as something the user typed.
			content: [{ type: "text", text: `<system-annotation>Prompt summary (${data.elapsed})</system-annotation>` }],
			display: true,
			details: data,
		})
	})
}
