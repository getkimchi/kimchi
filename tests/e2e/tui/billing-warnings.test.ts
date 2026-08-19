import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, INPUT_TIMEOUT_MS, waitForText } from "./support/assertions.js"
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
					JSON.stringify({ statusLine: { pinned: ["credits", "budget"] } }, null, "\t"),
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

// A Coder subscriber that runs out of credits is demoted to a free tier for rate limiting, and the
// credits API reports that demoted tier as the billing identity. Every field except `remaining`
// describes a user who never paid, so the warning has to key on the balance.
test("shows a rate-limit warning when a depleted Coder plan reports as free tier", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "billing-demoted-rate-limited",
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
					tier: "community",
					is_paid_tier: false,
					billing_status: "free_tier",
					has_credits: true,
					remaining: "0",
				},
			],
			responses: [{ stream: ["Done."] }],
		},
		async () => {
			terminal.submit("Use remaining credits")

			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "slower rate-limited mode", { full: true })
			await waitForText(terminal, "https://app.kimchi.dev/billing", { full: true })
		},
	)
})

test("explains BYO inference when the backend blocks a Community user", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "billing-community-inference-blocked",
			creditsResponses: [
				{
					serverless: true,
					tier: "free-slow",
					is_paid_tier: false,
					billing_status: "free_tier",
					has_credits: false,
					remaining: "0",
				},
			],
			responses: [],
		},
		async () => {
			await waitForText(terminal, "You are using the Community tier", { full: true })
			await waitForText(terminal, "bring your own", { full: true })
			await waitForText(terminal, "inference to the harness", { full: true })
			await waitForText(terminal, "To use Kimchi inference", { full: true })
			await waitForText(terminal, "upgrade", { full: true })
			await waitForText(terminal, "Coder.", { full: true })
			expect(fullText(terminal)).not.toContain("You ran out of credits")
			expect(fullText(terminal)).not.toContain("Top up at")
			expect(fullText(terminal)).not.toContain("You are using Community tier")

			const lines = fullText(terminal).split("\n")
			const headerBottom = lines.findIndex((line) => line.startsWith("└"))
			const blockedWarning = lines.findIndex((line) => line.includes("You are using the Community tier"))
			expect(blockedWarning).toBeGreaterThan(headerBottom)
		},
	)
})

test("keeps the available Community notice while the backend still serves inference", async ({ terminal }) => {
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
					JSON.stringify({ statusLine: { pinned: ["credits", "budget"] } }, null, "\t"),
					"utf-8",
				)
			},
		},
		async () => {
			await waitForText(terminal, "Credits: $18.40", { full: true })
			await waitForText(terminal, "Budget: 13.73% ($274.59/$2k)", { full: true })

			// Type the command and wait for it to echo, then press Enter on its own.
			// A one-shot submit can drop the command's leading `/`, which appears to
			// happen when the Enter bytes merge with the command text in one pty read.
			// Same approach as the theme-selector and todo-overlay tests.
			terminal.write("/budget")
			await waitForText(terminal, "/budget", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Budget  Jul 1–Aug 1 UTC", { full: true })
			await waitForText(terminal, "Personal", { full: true })
			await waitForText(terminal, "Organization per-user hard", { full: true })
			await waitForText(terminal, "anthropic", { full: true })

			terminal.submit("Use a few credits")
			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "Budget warning: Personal budget is 90% used ($1.8k/$2k).", { full: true })
			await waitForText(terminal, "Budget: 90.00% ($1.8k/$2k)", { full: true })
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
					JSON.stringify({ statusLine: { pinned: ["credits", "budget"] } }, null, "\t"),
					"utf-8",
				)
			},
		},
		async () => {
			terminal.submit("Use the remaining budget")
			await expect(terminal.getByText("Done.", { full: true })).toBeVisible()
			await waitForText(terminal, "Budget exhausted: Personal budget is fully used ($2k/$2k).", { full: true })
			await waitForText(terminal, "Budget: 100.00% ($2k/$2k)", { full: true })
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
