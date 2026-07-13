import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

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
