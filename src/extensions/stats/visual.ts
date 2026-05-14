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
		"cloud-code-otel": "Claude Code",
		"opencode-otel": "OpenCode",
		"pi-otel": "Kimchi",
	}
	return mapping[providerName] || providerName
}

/**
 * Maps provider name to source category for analytics table.
 * Unknown providers are classified as "Proxy".
 */
export function getSourceName(providerName: string): string {
	if (!providerName) return "Proxy"
	const mapping: Record<string, string> = {
		"cloud-code-otel": "Claude Code",
		"opencode-otel": "OpenCode",
		"pi-otel": "Kimchi",
	}
	return mapping[providerName] || "Proxy"
}

export type SortBy = "cost" | "tokens" | "model" | "source"

type SortStats = {
	modelName: string
	source: string
	cost: number
	inputTokens: number
	outputTokens: number
}

/**
 * Sort function for model stats with configurable sort criteria.
 * Exported for unit testing.
 */
export function sortFn(a: SortStats, b: SortStats, sortBy: SortBy): number {
	switch (sortBy) {
		case "tokens": {
			const aTokens = a.inputTokens + a.outputTokens
			const bTokens = b.inputTokens + b.outputTokens
			return bTokens - aTokens || a.modelName.localeCompare(b.modelName) || a.source.localeCompare(b.source)
		}
		case "model":
			return a.modelName.localeCompare(b.modelName) || a.source.localeCompare(b.source)
		case "source":
			return a.source.localeCompare(b.source) || a.modelName.localeCompare(b.modelName)
		default: {
			// cost
			return b.cost - a.cost || a.modelName.localeCompare(b.modelName) || a.source.localeCompare(b.source)
		}
	}
}

export function formatAnalyticsVisual(
	data: GenerateAnalyticsResponse,
	theme: Theme,
	termWidth = 100,
	days = 30,
	sortBy: SortBy = "cost",
): string[] {
	const lines: string[] = []

	lines.push("")
	lines.push(theme.bold(theme.fg("accent", "  Analytics")))
	lines.push(theme.fg("dim", `  Last ${days} Days`))
	lines.push("")

	// Collect model+source stats
	const modelStats = new Map<
		string,
		{
			modelName: string
			source: string
			cost: number
			inputTokens: number
			outputTokens: number
			inputCost: number
			outputCost: number
		}
	>()

	if (data.cost?.items) {
		for (const item of data.cost.items) {
			if (item.models) {
				for (const model of item.models) {
					const cost = Number.parseFloat(model.totalCost || "0")
					if (cost > 0) {
						const source = getSourceName(model.providerName)
						const key = `${model.model}\t${source}`
						const existing = modelStats.get(key) || {
							modelName: model.model,
							source,
							cost: 0,
							inputTokens: 0,
							outputTokens: 0,
							inputCost: 0,
							outputCost: 0,
						}
						existing.cost += cost
						existing.inputCost += Number.parseFloat(model.inputTokenCost || "0")
						existing.outputCost += Number.parseFloat(model.outputTokenCost || "0")
						modelStats.set(key, existing)
					}
				}
			}
		}
	}

	if (data.inputTokens?.items) {
		for (const item of data.inputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					const source = getSourceName(model.providerName)
					const key = `${model.model}\t${source}`
					const stats = modelStats.get(key) || {
						modelName: model.model,
						source,
						cost: 0,
						inputTokens: 0,
						outputTokens: 0,
						inputCost: 0,
						outputCost: 0,
					}
					stats.inputTokens += model.totalCount || 0
					modelStats.set(key, stats)
				}
			}
		}
	}

	if (data.outputTokens?.items) {
		for (const item of data.outputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					const source = getSourceName(model.providerName)
					const key = `${model.model}\t${source}`
					const stats = modelStats.get(key) || {
						modelName: model.model,
						source,
						cost: 0,
						inputTokens: 0,
						outputTokens: 0,
						inputCost: 0,
						outputCost: 0,
					}
					stats.outputTokens += model.totalCount || 0
					modelStats.set(key, stats)
				}
			}
		}
	}

	if (modelStats.size > 0) {
		// Fixed column widths for compact display
		const modelCol = 20
		const sourceCol = 12
		const tokensCol = 10
		const ioCol = 16
		const costCol = 10
		const costIoCol = 16
		const lineWidth = modelCol + sourceCol + tokensCol + ioCol + costCol + costIoCol + 5

		lines.push(
			`  ${"Model".padEnd(modelCol)} ${theme.fg("dim", "Source".padStart(sourceCol))} ${theme.fg("dim", "Tokens".padStart(tokensCol))} ${theme.fg("dim", "(I / O)".padStart(ioCol))} ${theme.fg("dim", "Cost".padStart(costCol))} ${theme.fg("dim", "(I / O)".padStart(costIoCol))}`,
		)
		lines.push(`  ${theme.fg("dim", "─".repeat(lineWidth))}`)

		let totalInputTokens = 0
		let totalOutputTokens = 0
		let totalModelCost = 0
		let totalInputCost = 0
		let totalOutputCost = 0

		const sortedModels = Array.from(modelStats.values()).sort((a, b) => sortFn(a, b, sortBy))
		for (const stats of sortedModels) {
			const label = stats.modelName.length > 15 ? `${stats.modelName.slice(0, 12)}...` : stats.modelName
			const totalTokens = stats.inputTokens + stats.outputTokens
			const tokenStr = formatCount(totalTokens).padStart(tokensCol)
			const ioStr = `${formatCount(stats.inputTokens)} / ${formatCount(stats.outputTokens)}`.padStart(ioCol)
			const costStr = formatCurrency(stats.cost).padStart(costCol)
			const costIoStr = `${formatCurrency(stats.inputCost)} / ${formatCurrency(stats.outputCost)}`.padStart(costIoCol)
			lines.push(
				`  ${theme.fg("accent", label.padEnd(modelCol))} ${theme.fg("accent", stats.source.padStart(sourceCol))} ${tokenStr} ${ioStr} ${costStr} ${costIoStr}`,
			)

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
		lines.push(
			`  ${theme.fg("dim", "Total".padEnd(modelCol))} ${"".padStart(sourceCol)} ${totalTokensStr} ${totalIoStr} ${totalCostStr} ${totalCostIoStr}`,
		)
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
