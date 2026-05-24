import { type ToolArgs, computeLineChanges, computeWriteLines, inferLanguage } from "./helpers.js"
import type { MetricData } from "./transport.js"

// ---------------------------------------------------------------------------
// Cumulative metric state
// ---------------------------------------------------------------------------

export interface CumulativeState {
	tokensByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
	costByModel: Record<string, number>
	commitCount: number
	prCount: number
	locByLanguage: Record<string, { added: number; removed: number }>
	editDecisions: Record<string, number>
	sessionStartNano: string
}

export function createCumulativeState(): CumulativeState {
	return {
		tokensByModel: {},
		costByModel: {},
		commitCount: 0,
		prCount: 0,
		locByLanguage: {},
		editDecisions: {},
		sessionStartNano: String(Date.now() * 1_000_000),
	}
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

export function accumulateLoc(state: CumulativeState, language: string, added: number, removed: number): void {
	if (!state.locByLanguage[language]) state.locByLanguage[language] = { added: 0, removed: 0 }
	state.locByLanguage[language].added += added
	state.locByLanguage[language].removed += removed
}

export function recordEditDecision(state: CumulativeState, toolName: string, language: string): void {
	const key = [toolName, "accept", language, "auto"].join("|")
	state.editDecisions[key] = (state.editDecisions[key] || 0) + 1
}

export function handleBashCumulativeMetrics(state: CumulativeState, args: ToolArgs): void {
	const command = String(args?.command ?? "")
	if (/git\s+commit\b/.test(command) && !/--dry-run/.test(command)) state.commitCount++
	if (/gh\s+pr\s+create\b/.test(command)) state.prCount++
}

export function handleEditCumulativeMetrics(state: CumulativeState, toolName: string, args: ToolArgs): void {
	const filePath = String(args?.path ?? "")
	const language = inferLanguage(filePath)

	if (toolName === "write") {
		const added = computeWriteLines(args)
		accumulateLoc(state, language, added, 0)
	} else {
		const changes = computeLineChanges(toolName, args)
		accumulateLoc(state, language, changes.added, changes.removed)
	}
	recordEditDecision(state, toolName, language)
}

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

export function collectMetrics(state: CumulativeState): MetricData[] {
	const out: MetricData[] = []

	for (const [model, t] of Object.entries(state.tokensByModel)) {
		for (const [type, val] of Object.entries(t) as [string, number][]) {
			if (val > 0) {
				const otelType = type === "cacheWrite" ? "cacheCreation" : type
				out.push({ name: "claude_code.token.usage", type: "Sum", value: val, attrs: { type: otelType, model } })
			}
		}
	}
	for (const [model, cost] of Object.entries(state.costByModel)) {
		if (cost > 0) out.push({ name: "claude_code.cost.usage", type: "Sum", value: cost, attrs: { model } })
	}
	if (state.commitCount > 0) {
		out.push({
			name: "claude_code.commit.count",
			type: "Sum",
			value: state.commitCount,
			attrs: { tool_name: "bash", decision: "git_commit" },
		})
	}
	if (state.prCount > 0) {
		out.push({
			name: "claude_code.pull_request.count",
			type: "Sum",
			value: state.prCount,
			attrs: { tool_name: "bash", decision: "gh_pr_create" },
		})
	}
	for (const [language, counts] of Object.entries(state.locByLanguage)) {
		if (counts.added > 0)
			out.push({
				name: "claude_code.lines_of_code.count",
				type: "Sum",
				value: counts.added,
				attrs: { type: "added", language },
			})
		if (counts.removed > 0)
			out.push({
				name: "claude_code.lines_of_code.count",
				type: "Sum",
				value: counts.removed,
				attrs: { type: "removed", language },
			})
	}
	for (const [key, count] of Object.entries(state.editDecisions)) {
		const [toolName, decision, language, source] = key.split("|")
		out.push({
			name: "claude_code.code_edit_tool.decision",
			type: "Sum",
			value: count,
			attrs: { tool_name: toolName, decision, language, source },
		})
	}
	return out
}
