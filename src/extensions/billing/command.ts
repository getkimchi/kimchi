import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import {
	type BudgetEntry,
	type BudgetSnapshot,
	budgetLabel,
	budgetStatus,
	budgetUsagePercentage,
	formatBudgetAmount,
	formatBudgetLimit,
	getBillingStatus,
	isCappedProviderLimitType,
	providerBudgetUsagePercentage,
	refreshBillingStatusFromConfig,
} from "./status.js"

const BUDGET_WIDTH = 31
const USED_WIDTH = 11
const LIMIT_WIDTH = 11
const USAGE_WIDTH = 9
const TABLE_WIDTH = BUDGET_WIDTH + USED_WIDTH + LIMIT_WIDTH + USAGE_WIDTH

export function formatBudgetBreakdown(snapshot: BudgetSnapshot, theme: Theme): string[] {
	return [
		`${theme.bold(theme.fg("accent", "Budget"))}  ${theme.fg("dim", formatBudgetPeriod(snapshot))}`,
		"",
		theme.bold(theme.fg("dim", tableRow("BUDGET", "USED", "LIMIT", "USAGE"))),
		theme.fg("dim", "─".repeat(TABLE_WIDTH)),
		...snapshot.budgets.flatMap((budget, index) => [...(index > 0 ? [""] : []), ...formatBudgetRow(budget, theme)]),
	]
}

function formatBudgetPeriod(snapshot: BudgetSnapshot): string {
	const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
	const start = new Date(snapshot.period.startTime)
	const end = new Date(snapshot.period.endTime)
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "current UTC month"
	return `${formatter.format(start)}–${formatter.format(end)} UTC`
}

function formatBudgetRow(budget: BudgetEntry, theme: Theme): string[] {
	const status = budgetStatus(budget)
	const color = statusColor(status)
	const percentage = budgetUsagePercentage(budget)
	const rows = [
		`${theme.bold(budgetLabel(budget).padEnd(BUDGET_WIDTH))}${theme.fg("accent", formatBudgetAmount(budget.totalSpendUsd).padStart(USED_WIDTH))}${theme.fg("dim", formatBudgetLimit(budget.budgetLimitUsd).padStart(LIMIT_WIDTH))}${theme.fg(color, `${percentage.toFixed(2)}%`.padStart(USAGE_WIDTH))}`,
	]
	for (const [index, provider] of budget.providerBudgets.entries()) {
		const capped = isCappedProviderLimitType(provider.limitType)
		const providerPercentage = providerBudgetUsagePercentage(provider)
		const branch = index === budget.providerBudgets.length - 1 ? "└─" : "├─"
		const usage = capped ? `${providerPercentage.toFixed(2)}%` : "—"
		rows.push(
			`${theme.fg("dim", `  ${branch} ${provider.provider}`.padEnd(BUDGET_WIDTH))}${theme.fg("accent", formatBudgetAmount(provider.usageUsd).padStart(USED_WIDTH))}${theme.fg("dim", formatProviderLimit(provider.limitType, provider.budgetLimitUsd).padStart(LIMIT_WIDTH))}${theme.fg(capped ? usageColor(providerPercentage) : "dim", usage.padStart(USAGE_WIDTH))}`,
		)
	}
	return rows
}

function tableRow(budget: string, used: string, limit: string, usage: string): string {
	return `${budget.padEnd(BUDGET_WIDTH)}${used.padStart(USED_WIDTH)}${limit.padStart(LIMIT_WIDTH)}${usage.padStart(USAGE_WIDTH)}`
}

function statusColor(status: ReturnType<typeof budgetStatus>): "success" | "warning" | "error" {
	if (status === "WARNING") return "warning"
	if (status === "EXHAUSTED") return "error"
	return "success"
}

function usageColor(percentage: number): "success" | "warning" | "error" {
	if (percentage >= 100) return "error"
	if (percentage >= 90) return "warning"
	return "success"
}

function formatProviderLimit(limitType: string, budgetLimitUsd: string): string {
	if (limitType.endsWith("_DISABLED") || limitType === "DISABLED") return "disabled"
	if (limitType.endsWith("_UNLIMITED") || limitType === "UNLIMITED") return "unlimited"
	if (isCappedProviderLimitType(limitType) && Number(budgetLimitUsd) === 0) return "$0"
	return formatBudgetLimit(budgetLimitUsd)
}

async function handleBudgetCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return
	await refreshBillingStatusFromConfig()
	const budget = getBillingStatus()?.budget
	if (!budget) {
		ctx.ui.notify("Budget information is currently unavailable.", "warning")
		return
	}
	if (budget.budgets.length === 0) {
		ctx.ui.notify("No budget is configured for this API key owner.", "info")
		return
	}
	ctx.ui.notify(formatBudgetBreakdown(budget, ctx.ui.theme).join("\n"), "info")
}

export default function budgetCommandExtension(pi: ExtensionAPI): void {
	pi.registerCommand("budget", {
		description: "Show current budget and usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await handleBudgetCommand(ctx)
		},
	})
}
