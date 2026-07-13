import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { startFakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"
import { getAgentDir, spawnInteractive } from "./harness.js"

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape stripping in PTY output assertions.
const TERMINAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const visibleText = (out: string): string => out.replace(TERMINAL_ESCAPE, "")
const hasCreditsStatusLine = (out: string): boolean => visibleText(out).includes("Credits: $5.00")

it("renders pinned Billing status-line status from the credits API", { timeout: 30_000 }, async () => {
	const fake = await startFakeOpenAiServer({
		responses: [],
		creditsResponses: [
			{
				serverless: true,
				tier: "coder",
				is_paid_tier: true,
				billing_status: "low_balance",
				has_credits: true,
				remaining: "5",
			},
		],
	})
	const agentDir = getAgentDir()
	writeFileSync(
		join(agentDir, "..", "config.json"),
		JSON.stringify(
			{
				apiKey: "fake",
				llmEndpoint: fake.baseUrl,
				skillPaths: [],
				migrationState: "done",
				onboarding: { hideSessionModeDialog: true },
			},
			null,
			"\t",
		),
		"utf-8",
	)
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ statusLine: { pinned: ["billing"] } }, null, "\t"),
		"utf-8",
	)

	const session = spawnInteractive()
	try {
		await session.waitFor((out) => out.includes("Trust project folder?") || hasCreditsStatusLine(out), 15_000)
		if (session.output().includes("Trust project folder?")) {
			session.write("\n")
		}
		await session.waitFor(hasCreditsStatusLine, 15_000)
		const creditsRequest = fake.requests.find((req) => req.method === "GET" && req.url.startsWith("/v1/credits"))
		expect(creditsRequest?.headers.authorization).toBe("Bearer fake")
	} finally {
		await session.kill()
		await fake.stop()
	}
})
