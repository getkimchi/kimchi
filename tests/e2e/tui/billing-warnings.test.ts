import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("shows paid balance at startup and low-credit warning after a model response", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "billing-low-warning",
			creditsResponses: [
				{
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "ok",
					has_credits: true,
					remaining: "10",
				},
				{
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "low_balance",
					has_credits: true,
					remaining: "5",
				},
			],
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, "\t"),
					"utf-8",
				)
			},
		},
		async () => {
			await waitForText(terminal, "Credits: $10.00", { full: true })

			terminal.submit("Use a few credits")

			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "Heads up: your credits are running low", { full: true })
			await waitForText(terminal, "https://app.kimchi.dev/billing", { full: true })
			await waitForText(terminal, "Credits: $5.00", { full: true })
		},
	)
})

test("shows exhausted-credit warning from credits API after a model response", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "billing-exhausted-warning",
			creditsResponses: [
				{
					serverless: true,
					tier: "teams",
					is_paid_tier: true,
					billing_status: "ok",
					has_credits: true,
					remaining: "10",
				},
				{
					serverless: true,
					tier: "teams",
					is_paid_tier: true,
					billing_status: "depleted",
					has_credits: false,
					remaining: "0",
				},
			],
			responses: [{ stream: ["Done."] }],
		},
		async () => {
			terminal.submit("Use remaining credits")

			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "You ran out of credits. Top up at https://app.kimchi.dev/billing", { full: true })
		},
	)
})

test("shows Community tier notice from the credits API in the startup header", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "billing-community-header",
			creditsResponses: [
				{
					serverless: true,
					tier: "community",
					is_paid_tier: false,
					billing_status: "free_tier",
					has_credits: true,
					remaining: "5",
				},
			],
			responses: [],
		},
		async () => {
			await waitForText(terminal, "You are using Community tier", { full: true })
			await waitForText(terminal, "app.kimchi.dev/pricing", { full: true })
		},
	)
})

test("shows caller budget in the footer and command, then refreshes a budget warning after a response", async ({
	terminal,
}) => {
	const healthyBudget = budgetResponse("274.594050")
	const warningBudget = budgetResponse("1800.000000")

	await runKimchiSession(
		terminal,
		{
			artifactName: "caller-budget-breakdown-and-warning",
			creditsResponses: [
				{
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "ok",
					has_credits: true,
					remaining: "18.4",
				},
			],
			budgetResponses: [healthyBudget, healthyBudget, warningBudget],
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, "\t"),
					"utf-8",
				)
			},
		},
		async () => {
			await waitForText(terminal, "Credits: $18.40", { full: true })
			await waitForText(terminal, "Budget: $274.59/$2k", { full: true })

			terminal.submit("/budget")
			await waitForText(terminal, "Budget — Jul 1–Aug 1 UTC", { full: true })
			await waitForText(terminal, "ACTIVE    Personal", { full: true })
			await waitForText(terminal, "ACTIVE    Organization per-user hard", { full: true })
			await waitForText(terminal, "anthropic", { full: true })

			terminal.submit("Use a few credits")
			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "Budget warning: Personal budget is 90% used ($1.8k/$2k).", { full: true })
			await waitForText(terminal, "Budget: $1.8k/$2k", { full: true })
		},
	)
})

test("shows an exhausted budget warning after a model response", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "caller-budget-exhausted-warning",
			creditsResponses: [
				{
					serverless: true,
					tier: "coder",
					is_paid_tier: true,
					billing_status: "ok",
					has_credits: true,
					remaining: "18.4",
				},
			],
			budgetResponses: [budgetResponse("100.000000"), budgetResponse("2000.000000")],
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, "\t"),
					"utf-8",
				)
			},
		},
		async () => {
			terminal.submit("Use the remaining budget")
			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "Budget exhausted: Personal budget is fully used ($2k/$2k).", { full: true })
			await waitForText(terminal, "Budget: $2k/$2k", { full: true })
		},
	)
})

function budgetResponse(totalSpendUsd: string) {
	return {
		period: { startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" },
		budgets: [
			{
				scope: "USER",
				scopeId: "owner",
				budgetType: "BUDGET_TYPE_PER_USER",
				budgetLimitUsd: "2000.000000",
				totalSpendUsd,
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
				totalSpendUsd,
				providerBudgets: [],
			},
		],
	}
}
