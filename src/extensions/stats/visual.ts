/**
 * Visual dashboard formatting for stats data
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { formatCount } from "../format.js"
import type {
	DimensionValue,
	GenerateAnalyticsResponse,
	GetProductivityMetricsResponse,
	MetricSummary,
	ProviderProductivityMetrics,
} from "./types.js"

export function formatCurrency(amount: string | number): string {
	const num = typeof amount === "string" ? Number.parseFloat(amount) : amount
	if (Number.isNaN(num)) return "$0.00"
	return `$${num.toFixed(2)}`
}

export function formatDurationCompact(seconds: number): string {
	const hours = Math.floor(seconds / 3600)
	const mins = Math.floor((seconds % 3600) / 60)
	if (hours > 0) {
		return `${hours}h ${mins}m`
	}
	return `${mins}m`
}

/**
 * Maps provider name to a friendly display name
 */
export function getProviderDisplayName(providerName: string): string {
	const mapping: Record<string, string> = {
		"claude-code-otel": "Claude Code",
		"opencode-otel": "OpenCode",
		"pi-otel": "Kimchi",
	}
	return mapping[providerName] || providerName
}

export function formatAnalyticsVisual(
	data: GenerateAnalyticsResponse,
	theme: Theme,
	termWidth = 100,
	days = 30,
): string[] {
	const lines: string[] = []

	lines.push("")
	lines.push(theme.bold(theme.fg("accent", "  Analytics")))
	lines.push(theme.fg("dim", `  Last ${days} Days`))
	lines.push("")

	// Collect model stats
	const modelStats = new Map<
		string,
		{ cost: number; inputTokens: number; outputTokens: number; inputCost: number; outputCost: number }
	>()

	if (data.cost?.items) {
		for (const item of data.cost.items) {
			if (item.models) {
				for (const model of item.models) {
					const cost = Number.parseFloat(model.totalCost || "0")
					if (cost > 0) {
						const existing = modelStats.get(model.model) || {
							cost: 0,
							inputTokens: 0,
							outputTokens: 0,
							inputCost: 0,
							outputCost: 0,
						}
						existing.cost += cost
						existing.inputCost += Number.parseFloat(model.inputTokenCost || "0")
						existing.outputCost += Number.parseFloat(model.outputTokenCost || "0")
						modelStats.set(model.model, existing)
					}
				}
			}
		}
	}

	if (data.inputTokens?.items) {
		for (const item of data.inputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					const stats = modelStats.get(model.model) || {
						cost: 0,
						inputTokens: 0,
						outputTokens: 0,
						inputCost: 0,
						outputCost: 0,
					}
					stats.inputTokens += model.totalCount || 0
					modelStats.set(model.model, stats)
				}
			}
		}
	}

	if (data.outputTokens?.items) {
		for (const item of data.outputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					const stats = modelStats.get(model.model) || {
						cost: 0,
						inputTokens: 0,
						outputTokens: 0,
						inputCost: 0,
						outputCost: 0,
					}
					stats.outputTokens += model.totalCount || 0
					modelStats.set(model.model, stats)
				}
			}
		}
	}

	if (modelStats.size > 0) {
		// Fixed column widths for compact display
		const modelCol = 20
		const tokensCol = 12
		const ioCol = 18
		const costCol = 12
		const costIoCol = 18
		const lineWidth = modelCol + tokensCol + ioCol + costCol + costIoCol + 4

		lines.push(
			`  ${"Model".padEnd(modelCol)} ${"Tokens".padStart(tokensCol)} ${"(I / O)".padStart(ioCol)} ${"Cost".padStart(costCol)} ${"(I / O)".padStart(costIoCol)}`,
		)
		lines.push(`  ${theme.fg("dim", "─".repeat(lineWidth))}`)

		let totalInputTokens = 0
		let totalOutputTokens = 0
		let totalModelCost = 0
		let totalInputCost = 0
		let totalOutputCost = 0

		const sortedModels = Array.from(modelStats.entries()).sort((a, b) => b[1].cost - a[1].cost)
		for (const [model, stats] of sortedModels.slice(0, 6)) {
			const label = model.length > 15 ? `${model.slice(0, 12)}...` : model
			const totalTokens = stats.inputTokens + stats.outputTokens
			const tokenStr = formatCount(totalTokens).padStart(tokensCol)
			const ioStr = `${formatCount(stats.inputTokens)} / ${formatCount(stats.outputTokens)}`.padStart(ioCol)
			const costStr = formatCurrency(stats.cost).padStart(costCol)
			const costIoStr = `${formatCurrency(stats.inputCost)} / ${formatCurrency(stats.outputCost)}`.padStart(costIoCol)
			lines.push(`  ${theme.fg("accent", label.padEnd(modelCol))} ${tokenStr} ${ioStr} ${costStr} ${costIoStr}`)

			totalInputTokens += stats.inputTokens
			totalOutputTokens += stats.outputTokens
			totalModelCost += stats.cost
			totalInputCost += stats.inputCost
			totalOutputCost += stats.outputCost
		}

		lines.push(`  ${theme.fg("dim", "─".repeat(lineWidth))}`)
		const totalTokensStr = formatCount(totalInputTokens + totalOutputTokens).padStart(tokensCol)
		const totalIoStr = `${formatCount(totalInputTokens)} / ${formatCount(totalOutputTokens)}`.padStart(ioCol)
		const totalCostStr = formatCurrency(totalModelCost).padStart(costCol)
		const totalCostIoStr = `${formatCurrency(totalInputCost)} / ${formatCurrency(totalOutputCost)}`.padStart(costIoCol)
		lines.push(`  ${"Total".padEnd(modelCol)} ${totalTokensStr} ${totalIoStr} ${totalCostStr} ${totalCostIoStr}`)
	}

	return lines
}

export function formatProductivityVisual(
	data: GetProductivityMetricsResponse,
	theme: Theme,
	termWidth = 100,
	days = 30,
): string[] {
	const lines: string[] = []

	lines.push("")
	lines.push(theme.bold(theme.fg("accent", "  Coding Agent Metrics")))
	lines.push(theme.fg("dim", `  Last ${days} Days`))

	if (!data.items?.length) {
		lines.push(theme.fg("dim", "  No data"))
		return lines
	}

	// Fixed column widths (not responsive) for compact display
	const metricCol = 16
	const providerCol = 20
	const lineWidth = metricCol + providerCol * data.items.length + 4

	const providers = data.items.map((item) => {
		const name = getProviderDisplayName(item.providerName || "unknown")
		return name.length > providerCol - 3 ? `${name.slice(0, providerCol - 6)}...` : name
	})

	// Helper to get breakdown value from summaries
	const getBreakdown = (
		item: ProviderProductivityMetrics,
		metricName: string,
		dimension: string,
		value: string,
	): number => {
		const summary = item.summaries?.find((s) => s.metricName === metricName)
		if (!summary?.breakdown) return 0
		const entry = summary.breakdown.find((b) => b.dimension === dimension && b.value === value)
		return entry?.valueSum ?? 0
	}

	const rows: { label: string; values: string[]; bold?: boolean }[] = []

	// Session metrics
	rows.push({
		label: "Sessions",
		values: data.items.map((item) => {
			const val = item.sessionStats?.totalSessions ?? 0
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "Duration",
		values: data.items.map((item) => {
			const seconds = item.sessionStats?.totalDurationSeconds ?? 0
			return seconds > 0 ? formatDurationCompact(seconds) : "-"
		}),
	})
	rows.push({
		label: "Median",
		values: data.items.map((item) => {
			const seconds = item.sessionStats?.durationP50Seconds ?? 0
			return seconds > 0 ? formatDurationCompact(seconds) : "-"
		}),
	})

	// Lines of Code - granular
	rows.push({
		label: "LoC Added",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.lines_of_code.count", "type", "added")
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "LoC Removed",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.lines_of_code.count", "type", "removed")
			return val > 0 ? formatCount(val) : "-"
		}),
	})

	// Commits & PRs
	rows.push({
		label: "Commits",
		values: data.items.map((item) => {
			const val = item.comparison?.commits?.value ?? 0
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "PRs",
		values: data.items.map((item) => {
			const val = item.comparison?.pullRequests?.value ?? 0
			return val > 0 ? String(val) : "-"
		}),
	})

	// Tool usage
	rows.push({
		label: "Tool Calls",
		values: data.items.map((item) => {
			const val = item.comparison?.toolUsage?.value ?? 0
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "Edit Tool",
		values: data.items.map((item) => {
			const summary = item.summaries?.find((s) => s.metricName === "claude_code.code_edit_tool.decision")
			return summary ? formatCount(summary.totalValue) : "-"
		}),
	})

	// Tokens - granular breakdown
	rows.push({
		label: "Tokens In",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.token.usage", "type", "input")
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "Tokens Out",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.token.usage", "type", "output")
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "Cache Read",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.token.usage", "type", "cacheRead")
			return val > 0 ? formatCount(val) : "-"
		}),
	})
	rows.push({
		label: "Cache Create",
		values: data.items.map((item) => {
			const val = getBreakdown(item, "claude_code.token.usage", "type", "cacheCreation")
			return val > 0 ? formatCount(val) : "-"
		}),
	})

	// Cost
	rows.push({
		label: "Cost",
		values: data.items.map((item) => {
			const val = item.comparison?.cost?.value ?? 0
			return val > 0 ? formatCurrency(val) : "-"
		}),
	})

	// Render header
	lines.push("")
	let header = `  ${"Metric".padEnd(metricCol)}`
	for (const provider of providers) {
		header += ` ${theme.fg("accent", provider.padStart(providerCol))}`
	}
	lines.push(header)
	lines.push(`  ${theme.fg("dim", "─".repeat(lineWidth))}`)

	// Render rows
	for (const row of rows) {
		let line = `  ${(row.bold ? theme.bold(row.label) : row.label).padEnd(metricCol)}`
		for (const value of row.values) {
			const displayValue = row.bold && value !== "-" ? theme.bold(value) : value
			line += ` ${displayValue.padStart(providerCol)}`
		}
		lines.push(line)
	}

	return lines
}
