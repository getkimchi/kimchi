/**
 * Terminal display formatting for stats data
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { formatCount } from "../format.js"
import type { GenerateAnalyticsResponse, GetProductivityMetricsResponse } from "./types.js"

function formatCurrency(amount: string | number): string {
	const num = typeof amount === "string" ? Number.parseFloat(amount) : amount
	if (Number.isNaN(num)) return "$0.00"
	return `$${num.toFixed(2)}`
}

function formatChangeIndicator(change: number, theme: Theme): string {
	if (change > 0) {
		return theme.fg("error", `+${change.toFixed(1)}%`)
	}
	if (change < 0) {
		return theme.fg("success", `${change.toFixed(1)}%`)
	}
	return theme.fg("dim", "0%")
}

function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600)
	const mins = Math.floor((seconds % 3600) / 60)
	if (hours > 0) {
		return `${hours}h ${mins}m`
	}
	return `${mins}m`
}

export function formatAnalyticsSummary(data: GenerateAnalyticsResponse, theme: Theme): string[] {
	const lines: string[] = []

	lines.push("")
	lines.push(theme.bold(theme.fg("accent", "📊 Analytics (Last 30 Days)")))

	// Token usage section
	let totalInput = 0
	let totalOutput = 0

	if (data.inputTokens?.items) {
		for (const item of data.inputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					totalInput += model.totalCount || 0
				}
			}
		}
	}

	if (data.outputTokens?.items) {
		for (const item of data.outputTokens.items) {
			if (item.models) {
				for (const model of item.models) {
					totalOutput += model.totalCount || 0
				}
			}
		}
	}

	const total = totalInput + totalOutput

	// Cost section
	let totalCost = 0
	if (data.cost?.items) {
		for (const item of data.cost.items) {
			if (item.models) {
				for (const model of item.models) {
					totalCost += Number.parseFloat(model.totalCost || "0")
				}
			}
		}
	}

	// API calls section
	let totalCalls = 0
	if (data.apiCalls?.items) {
		for (const item of data.apiCalls.items) {
			if (item.models) {
				totalCalls += item.models.length
			}
		}
	}

	// Main stats line with breakdown
	const mainParts: string[] = []
	if (total > 0) {
		const tokenPart = `${theme.fg("accent", formatCount(total))} (${formatCount(totalInput)}⇣ ${formatCount(totalOutput)}⇡)`
		mainParts.push(`${theme.bold("Tokens:")} ${tokenPart}`)
	}
	if (totalCost > 0) mainParts.push(`${theme.bold("Cost:")} ${theme.fg("accent", formatCurrency(totalCost))}`)
	if (totalCalls > 0) mainParts.push(`${theme.bold("Calls:")} ${theme.fg("accent", formatCount(totalCalls))}`)

	if (mainParts.length > 0) {
		lines.push(`  ${mainParts.join("  ")}`)
	}

	// Change indicators line
	const changeParts: string[] = []
	if (data.comparison?.inputTokens?.changePercentage !== undefined) {
		changeParts.push(`in: ${formatChangeIndicator(data.comparison.inputTokens.changePercentage, theme)}`)
	}
	if (data.comparison?.outputTokens?.changePercentage !== undefined) {
		changeParts.push(`out: ${formatChangeIndicator(data.comparison.outputTokens.changePercentage, theme)}`)
	}
	if (data.comparison?.cost?.changePercentage !== undefined) {
		changeParts.push(`cost: ${formatChangeIndicator(data.comparison.cost.changePercentage, theme)}`)
	}
	if (data.comparison?.apiCalls?.changePercentage !== undefined) {
		changeParts.push(`calls: ${formatChangeIndicator(data.comparison.apiCalls.changePercentage, theme)}`)
	}
	if (changeParts.length > 0) {
		lines.push(`  ${theme.bold("Change:")} ${changeParts.join("  ")}`)
	}

	// Model breakdown
	const modelCosts = new Map<string, number>()
	if (data.cost?.items) {
		for (const item of data.cost.items) {
			if (item.models) {
				for (const model of item.models) {
					const cost = Number.parseFloat(model.totalCost || "0")
					if (cost > 0) {
						const existing = modelCosts.get(model.model) || 0
						modelCosts.set(model.model, existing + cost)
					}
				}
			}
		}
	}

	if (modelCosts.size > 0) {
		const sortedModels = Array.from(modelCosts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
		const modelParts = sortedModels.map(([model, cost]) => `${model}: ${theme.fg("accent", formatCurrency(cost))}`)
		lines.push(`  ${theme.bold("Models:")} ${modelParts.join(", ")}`)
	}

	if (data.mostRecentTime) {
		const recentDate = new Date(data.mostRecentTime)
		lines.push(theme.fg("dim", `  Last: ${recentDate.toLocaleDateString()}`))
	}

	return lines
}

export function formatProductivitySummary(data: GetProductivityMetricsResponse, theme: Theme): string[] {
	const lines: string[] = []

	lines.push("")
	lines.push(theme.bold(theme.fg("accent", "🚀 Productivity (Last 30 Days)")))

	if (!data.items?.length) {
		lines.push(theme.fg("dim", "  No data"))
		return lines
	}

	for (const item of data.items) {
		// Provider name as header
		if (item.providerName) {
			lines.push(`  ${theme.fg("accent", item.providerName)}`)
		}

		// Row 1: Sessions and duration stats
		if (item.sessionStats) {
			const stats = item.sessionStats
			const sessionParts: string[] = []
			sessionParts.push(`${theme.bold("Sessions:")} ${stats.totalSessions}`)
			sessionParts.push(`${formatDuration(stats.totalDurationSeconds)} total`)
			sessionParts.push(`${formatDuration(stats.durationP50Seconds)} median`)
			lines.push(`    ${sessionParts.join("  ")}`)
		}

		// Row 2: Activity metrics
		if (item.comparison) {
			const comp = item.comparison
			const activityParts: string[] = []
			if (comp.linesOfCode?.value) activityParts.push(`${theme.bold("LoC:")} ${formatCount(comp.linesOfCode.value)}`)
			if (comp.commits?.value) activityParts.push(`${theme.bold("Commits:")} ${formatCount(comp.commits.value)}`)
			if (comp.pullRequests?.value) activityParts.push(`${theme.bold("PRs:")} ${formatCount(comp.pullRequests.value)}`)
			if (comp.toolUsage?.value) activityParts.push(`${theme.bold("Tools:")} ${formatCount(comp.toolUsage.value)}`)
			if (activityParts.length > 0) {
				lines.push(`    ${activityParts.join("  ")}`)
			}

			// Row 3: Usage metrics
			const usageParts: string[] = []
			if (comp.tokens?.value) usageParts.push(`${theme.bold("Tokens:")} ${formatCount(comp.tokens.value)}`)
			if (comp.cost?.value) usageParts.push(`${theme.bold("Cost:")} ${formatCurrency(comp.cost.value)}`)
			if (usageParts.length > 0) {
				lines.push(`    ${usageParts.join("  ")}`)
			}
		}

		// Row 4: Additional metric summaries
		if (item.summaries?.length) {
			const summaryParts = item.summaries.slice(0, 5).map((s) => {
				const shortName = s.metricName?.replace(/claude_code\./, "").replace(/_/g, " ") ?? ""
				return `${shortName}: ${formatCount(s.totalValue)}`
			})
			if (summaryParts.length > 0) {
				lines.push(`    ${theme.fg("dim", summaryParts.join("  "))}`)
			}
		}
	}

	return lines
}

export function formatError(message: string, theme: Theme): string[] {
	return ["", theme.fg("error", `Error: ${message}`), ""]
}

export function formatHelp(theme: Theme): string[] {
	return [
		"",
		theme.bold("Stats Command Usage"),
		"",
		"  /stats                    Show analytics and productivity metrics (last 30 days)",
		"  /stats 7                  Show metrics for last 7 days",
		"  /stats tokens             Sort by tokens",
		"  /stats 7 model            Sort by model name (7 days)",
		"  /stats help               Show this help message",
		"",
		"  Sort: cost (default), tokens, model, source",
		"",
	]
}
