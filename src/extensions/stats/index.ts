/**
 * Stats Extension
 *
 * Provides /stats command to view Cast AI analytics directly in the TUI.
 * Fetches data from:
 * - Analytics API (generateAnalyticsReport)
 * - Productivity Metrics API (getProductivityMetrics)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { CastAiStatsApi, getTimeRange } from "./api.js"
import { formatError, formatHelp } from "./display.js"
import { type SortBy, formatAnalyticsVisual, formatProductivityVisual } from "./visual.js"

function createApiClient(): CastAiStatsApi {
	const apiKey = loadConfig().apiKey || process.env.CASTAI_API_KEY
	if (!apiKey) {
		throw new Error("No API key found. Please run `kimchi login` to set up your API key.")
	}
	return new CastAiStatsApi({ apiKey })
}

/**
 * Parse /stats command arguments into days and sortBy values.
 * Exported for unit testing.
 */
export function parseStatsArgs(args: string): { days: number; sortBy: SortBy } {
	const trimmed = args.trim().toLowerCase()
	let days = 30
	let sortBy: SortBy = "cost"

	if (trimmed) {
		const parts = trimmed.split(/\s+/)
		const sortValues: SortBy[] = ["cost", "tokens", "model", "source"]

		for (const part of parts) {
			const parsedDays = Number.parseInt(part, 10)
			if (!Number.isNaN(parsedDays) && parsedDays > 0 && parsedDays <= 365) {
				days = parsedDays
			} else if (sortValues.includes(part as SortBy)) {
				sortBy = part as SortBy
			}
		}
	}

	return { days, sortBy }
}

async function handleStatsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		return
	}

	const trimmed = args.trim().toLowerCase()

	// Show help if requested
	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		const helpLines = formatHelp(ctx.ui.theme)
		ctx.ui.notify(helpLines.join("\n"), "info")
		return
	}

	// Parse arguments
	const { days, sortBy } = parseStatsArgs(args)

	const api = createApiClient()
	const { startTime, endTime } = getTimeRange(days)

	// Show loading indicator while fetching data
	ctx.ui.notify(`Fetching stats for last ${days} days...`, "info")

	try {
		const outputLines: string[] = []
		const terminalWidth = process.stdout.columns ?? 100

		// Fetch analytics data
		try {
			const analytics = await api.generateAnalytics(startTime, endTime)
			const hasTokenData = analytics.inputTokens?.items?.length || analytics.outputTokens?.items?.length
			const hasCostData = analytics.cost?.items?.length
			const hasApiCalls = analytics.apiCalls?.items?.length

			if (!hasTokenData && !hasCostData && !hasApiCalls) {
				outputLines.push("", ctx.ui.theme.fg("dim", "No analytics data found for the selected period."), "")
			} else {
				const analyticsLines = formatAnalyticsVisual(analytics, ctx.ui.theme, terminalWidth, days, sortBy)
				outputLines.push(...analyticsLines)
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			outputLines.push(...formatError(`Analytics API: ${msg}`, ctx.ui.theme))
		}

		// Fetch productivity metrics
		try {
			const productivity = await api.getProductivityMetrics(startTime, endTime)
			const hasItems = productivity.items?.length && productivity.items.length > 0

			if (!hasItems) {
				outputLines.push("", ctx.ui.theme.fg("dim", "No productivity data found for the selected period."), "")
			} else {
				const productivityLines = formatProductivityVisual(productivity, ctx.ui.theme, terminalWidth, days)
				outputLines.push(...productivityLines)
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			outputLines.push(...formatError(`Productivity API: ${msg}`, ctx.ui.theme))
		}

		// Display all collected output
		if (outputLines.length > 0) {
			ctx.ui.notify(outputLines.join("\n"), "info")
		} else {
			ctx.ui.notify("No data available", "info")
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		ctx.ui.notify(formatError(message, ctx.ui.theme).join("\n"), "error")
	}
}

export default function statsExtension(pi: ExtensionAPI) {
	pi.registerCommand("stats", {
		description: "View coding analytics and metrics (/stats 7 for last 7 days)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleStatsCommand(args, ctx)
		},
	})
}
