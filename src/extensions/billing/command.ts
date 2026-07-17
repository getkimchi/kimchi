import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import {
	type BudgetEntry,
	type BudgetSnapshot,
	budgetLabel,
	budgetUsagePercentage,
	formatBudgetAmount,
	formatBudgetLimit,
	getBillingStatus,
	isCappedProviderLimitType,
	providerBudgetUsagePercentage,
	refreshBillingStatusFromConfig,
} from "./status.js"

export function formatBudgetBreakdown(snapshot: BudgetSnapshot): string[] {
	return [
		`Budget — ${formatBudgetPeriod(snapshot)}`,
		"",
		...snapshot.budgets.flatMap((budget) => formatBudgetRow(budget)),
	]
}

function formatBudgetPeriod(snapshot: BudgetSnapshot): string {
	const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
	const start = new Date(snapshot.period.startTime)
	const end = new Date(snapshot.period.endTime)
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "current UTC month"
	return `${formatter.format(start)}–${formatter.format(end)} UTC`
}

function formatBudgetRow(budget: BudgetEntry): string[] {
	const label = budgetLabel(budget).padEnd(32)
	const amount = `${formatBudgetAmount(budget.totalSpendUsd)} / ${formatBudgetLimit(budget.budgetLimitUsd)}`.padEnd(18)
	const rows = [`${"ACTIVE".padEnd(10)}${label}${amount}${budgetUsagePercentage(budget).toFixed(2)}%`]
	for (const provider of budget.providerBudgets) {
		const providerAmount =
			`${formatBudgetAmount(provider.usageUsd)} / ${formatProviderLimit(provider.limitType, provider.budgetLimitUsd)}`.padEnd(
				18,
			)
		const percentage = isCappedProviderLimitType(provider.limitType)
			? `${providerBudgetUsagePercentage(provider).toFixed(2)}%`
			: ""
		rows.push(`  ${provider.provider.padEnd(20)}${providerAmount}${percentage}`)
	}
	return rows
}

function formatProviderLimit(limitType: string, budgetLimitUsd: string): string {
	if (limitType.endsWith("_DISABLED") || limitType === "DISABLED") return "disabled"
	if (limitType.endsWith("_UNLIMITED") || limitType === "UNLIMITED") return "unlimited"
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
	ctx.ui.notify(formatBudgetBreakdown(budget).join("\n"), "info")
}

export default function budgetCommandExtension(pi: ExtensionAPI): void {
	pi.registerCommand("budget", {
		description: "Show the current API key budget and usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await handleBudgetCommand(ctx)
		},
	})
}
