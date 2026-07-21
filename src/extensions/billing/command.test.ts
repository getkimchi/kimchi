import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createContext } from "../__mocks__/context.js"

const refreshBillingStatusFromConfigMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("./status.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./status.js")>()
	return { ...actual, refreshBillingStatusFromConfig: refreshBillingStatusFromConfigMock }
})

import budgetCommandExtension, { formatBudgetBreakdown } from "./command.js"
import { type BillingStatus, type BudgetSnapshot, setBillingStatusForTest } from "./status.js"

type BudgetCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

function registeredBudgetCommand(): BudgetCommand {
	let command: BudgetCommand | undefined
	budgetCommandExtension({
		registerCommand: (_name: string, config: BudgetCommand) => {
			command = config
		},
	} as unknown as ExtensionAPI)
	if (!command) throw new Error("budget command not registered")
	return command
}

function theme(): Theme {
	return {
		fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
		bold: vi.fn((text: string) => `<bold>${text}</bold>`),
	} as unknown as Theme
}

function unstyled(value: string): string {
	return value.replace(/<[^>]+>/g, "")
}

function billingStatus(budget: BudgetSnapshot | undefined): BillingStatus {
	return { updatedAt: "2026-07-01T00:00:00Z", ...(budget ? { budget } : {}) }
}

beforeEach(() => {
	refreshBillingStatusFromConfigMock.mockClear()
	setBillingStatusForTest(undefined)
})

describe("formatBudgetBreakdown", () => {
	it("renders active budget, provider, and UTC period rows deterministically", () => {
		const snapshot: BudgetSnapshot = {
			period: { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" },
			budgets: [
				{
					scope: "USER",
					scopeId: "owner",
					budgetType: "BUDGET_TYPE_PER_USER",
					budgetLimitUsd: "2000.000000",
					totalSpendUsd: "274.594050",
					providerBudgets: [
						{
							provider: "anthropic",
							limitType: "PROVIDER_BUDGET_LIMIT_TYPE_CAPPED",
							budgetLimitUsd: "400.000000",
							usageUsd: "273.201503",
						},
					],
				},
				{
					scope: "ORGANIZATION_HARD",
					scopeId: "516442fe-054a-49e2-ac2d-9dc9b104c3d2",
					budgetType: "BUDGET_TYPE_PER_USER",
					budgetLimitUsd: "300000.000000",
					totalSpendUsd: "274.594050",
					providerBudgets: [],
				},
			],
		}

		const output = formatBudgetBreakdown(snapshot, theme()).join("\n")
		expect(unstyled(output)).toBe(
			"Budget  Jul 1–Aug 1 UTC\n\nBUDGET                                USED      LIMIT    USAGE\n──────────────────────────────────────────────────────────────\nPersonal                           $274.59        $2k   13.73%\n  └─ anthropic                     $273.20       $400   68.30%\n\nOrganization per-user hard         $274.59      $300k    0.09%",
		)
		expect(output).toContain("<accent>Budget</accent>")
		expect(output).toContain("<success>")
	})

	it("renders disabled, unlimited, and zero-capped provider limits", () => {
		const snapshot: BudgetSnapshot = {
			period: { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" },
			budgets: [
				{
					scope: "USER",
					scopeId: "owner",
					budgetLimitUsd: "2000.000000",
					totalSpendUsd: "0.000000",
					providerBudgets: [
						{
							provider: "disabled-provider",
							limitType: "PROVIDER_BUDGET_LIMIT_TYPE_DISABLED",
							budgetLimitUsd: "400.000000",
							usageUsd: "0.000000",
						},
						{
							provider: "unlimited-provider",
							limitType: "PROVIDER_BUDGET_LIMIT_TYPE_UNLIMITED",
							budgetLimitUsd: "400.000000",
							usageUsd: "1.000000",
						},
						{
							provider: "zero-capped-provider",
							limitType: "PROVIDER_BUDGET_LIMIT_TYPE_CAPPED",
							budgetLimitUsd: "0.000000",
							usageUsd: "0.000000",
						},
					],
				},
			],
		}

		const output = formatBudgetBreakdown(snapshot, theme()).join("\n")
		expect(unstyled(output)).toContain("disabled-provider")
		expect(unstyled(output)).toContain("$0.00   disabled")
		expect(unstyled(output)).toContain("unlimited-provider")
		expect(unstyled(output)).toContain("$1.00  unlimited")
		const zeroCappedRow = output.split("\n").find((line) => line.includes("zero-capped-provider"))
		expect(zeroCappedRow).toContain("$0")
		expect(zeroCappedRow).not.toContain("unlimited")
		expect(output.split("\n").find((line) => line.includes("disabled-provider"))).not.toContain("%")
		expect(output.split("\n").find((line) => line.includes("unlimited-provider"))).not.toContain("%")
	})
})

describe("budget command", () => {
	it("reports unavailable budget information after refresh fails", async () => {
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify, theme: theme() } }) as ExtensionCommandContext

		await registeredBudgetCommand().handler("", ctx)

		expect(refreshBillingStatusFromConfigMock).toHaveBeenCalledOnce()
		expect(notify).toHaveBeenCalledWith("Budget information is currently unavailable.", "warning")
	})

	it("reports when the owner has no configured budget", async () => {
		setBillingStatusForTest(
			billingStatus({
				period: { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" },
				budgets: [],
			}),
		)
		const notify = vi.fn()
		const ctx = createContext({ ui: { notify, theme: theme() } }) as ExtensionCommandContext

		await registeredBudgetCommand().handler("", ctx)

		expect(notify).toHaveBeenCalledWith("No budget is configured for this API key owner.", "info")
	})
})
