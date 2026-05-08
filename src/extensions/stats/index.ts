/**
 * Stats Extension
 *
 * Provides /stats command to view Cast AI analytics directly in the TUI.
 * Fetches data from:
 * - Analytics API (generateAnalyticsReport)
 * - Productivity Metrics API (getProductivityMetrics)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { exitSplashMode } from "../ui.js"
import { CastAiStatsApi, getTimeRange } from "./api.js"
import { formatError, formatHelp } from "./display.js"
import { formatAnalyticsVisual, formatProductivityVisual } from "./visual.js"

// API key used for Cast AI API requests - must be provided via CASTAI_API_KEY env var

// Hardcoded user ID as specified
const HARDCODED_USER_ID = "d1c79c82-c230-4b19-9def-dbe49bf63368"

// Organization ID - provided by user
const ORGANIZATION_ID = "516442fe-054a-49e2-ac2d-9dc9b104c3d2"

interface StatsConfig {
	apiKey: string
	userId: string
	organizationId: string
}

function getStatsConfig(): StatsConfig {
	const envKey = process.env.CASTAI_API_KEY
	const envOrg = process.env.CASTAI_ORG_ID

	return {
		apiKey: envKey || "",
		userId: HARDCODED_USER_ID,
		organizationId: envOrg || ORGANIZATION_ID,
	}
}

function createApiClient(): CastAiStatsApi {
	const config = getStatsConfig()
	return new CastAiStatsApi({
		apiKey: config.apiKey,
		userId: config.userId,
		organizationId: config.organizationId,
	})
}

async function handleStatsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		return
	}

	const trimmed = args.trim().toLowerCase()

	// Exit splash mode and switch to chat view (do this early for all commands)
	exitSplashMode(ctx)

	// Show help if requested
	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		const helpLines = formatHelp(ctx.ui.theme)
		ctx.ui.notify(helpLines.join("\n"), "info")
		return
	}

	// Parse number of days (e.g., "/stats 7" for last 7 days)
	let days = 30 // default
	if (trimmed) {
		const parsedDays = Number.parseInt(trimmed, 10)
		if (!Number.isNaN(parsedDays) && parsedDays > 0 && parsedDays <= 365) {
			days = parsedDays
		}
	}

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
				const analyticsLines = formatAnalyticsVisual(analytics, ctx.ui.theme, terminalWidth, days)
				outputLines.push(...analyticsLines)
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes("404") || msg.includes("organization")) {
				outputLines.push(
					...formatError(
						"Analytics endpoint requires a valid organization ID. " +
							"Set CASTAI_ORG_ID environment variable if needed.",
						ctx.ui.theme,
					),
				)
			} else {
				outputLines.push(...formatError(`Analytics API: ${msg}`, ctx.ui.theme))
			}
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
