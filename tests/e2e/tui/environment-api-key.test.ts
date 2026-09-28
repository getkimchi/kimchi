import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const environmentKey = "environment-test-key"
const invalidKey = "invalid-environment-test-key"

function seedSavedAccount(homeDir: string) {
	const agentDir = join(homeDir, ".config", "kimchi", "harness")
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ "kimchi-dev": { type: "api_key", key: "saved-test-key" } }),
	)
	const configPath = join(homeDir, ".config", "kimchi", "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf-8"))
	writeFileSync(configPath, JSON.stringify({ ...config, apiKey: "saved-test-key" }))
	return {
		data: {
			auth: readFileSync(join(agentDir, "auth.json"), "utf-8"),
			models: readFileSync(join(agentDir, "models.json"), "utf-8"),
		},
	}
}

test("a valid environment key chats through the runtime catalog without changing saved auth or models", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "environment-api-key-valid",
			providerId: "kimchi-dev",
			models: [{ slug: "environment-model", displayName: "Environment Model", provider: "ai-enabler" }],
			responses: [{ stream: ["Environment account response."] }],
			env: { KIMCHI_API_KEY: environmentKey },
			seedHome: (homeDir) => {
				const saved = seedSavedAccount(homeDir)
				const path = join(homeDir, ".config", "kimchi", "harness", "models.json")
				const config = JSON.parse(readFileSync(path, "utf-8"))
				config.providers["kimchi-dev"].models[0].id = "saved-account-only-model"
				writeFileSync(path, JSON.stringify(config))
				saved.data.models = readFileSync(path, "utf-8")
				return saved
			},
		},
		async (fixture, trace) => {
			trace.step("runtime-only model selected despite a different model in the saved cache")
			terminal.submit("Say hello")
			await waitForText(terminal, "Environment account response.")
			const requests = fixture.fake.requests.filter(
				(request) => request.url.includes("/metadata") || request.url.includes("/chat/completions"),
			)
			expect(requests.some((request) => request.url.includes("/chat/completions"))).toBe(true)
			expect(requests.every((request) => request.headers.authorization === `Bearer ${environmentKey}`)).toBe(true)
			expect({
				auth: readFileSync(join(fixture.agentDir, "auth.json"), "utf-8"),
				models: readFileSync(join(fixture.agentDir, "models.json"), "utf-8"),
			}).toEqual(fixture.seedResult)
			trace.step("environment request completed; saved auth and models remain byte-identical")
		},
	)
})

test("an invalid environment key prints an actionable error without changing saved auth or models", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "environment-api-key-invalid",
			responses: [],
			rejectedApiKeys: [invalidKey],
			env: { KIMCHI_API_KEY: invalidKey },
			seedHome: seedSavedAccount,
			startupText: "environment variable contains an invalid API key",
		},
		async (fixture, trace) => {
			await waitForText(terminal, /then restart\s+Kimchi\./)
			const terminalText = fullText(terminal).replace(/\s+/g, " ")
			expect(terminalText).toContain(
				"KIMCHI_API_KEY environment variable contains an invalid API key. Update or delete the environment variable, then restart Kimchi.",
			)
			expect(terminalText).not.toContain(PROMPT_READY)
			expect(terminalText).not.toContain("Use a Kimchi account")
			expect(terminalText).not.toContain("Redirecting to setup")
			terminal.submit("echo KIMCHI_REJECTION_EXIT_$?")
			await waitForText(terminal, "KIMCHI_REJECTION_EXIT_1")
			expect(fixture.fake.requests.some((request) => request.url.includes("/chat/completions"))).toBe(false)
			const discoveryRequests = fixture.fake.requests.filter((request) => request.url.includes("/metadata"))
			expect(discoveryRequests.length).toBeGreaterThan(0)
			expect(discoveryRequests.every((request) => request.headers.authorization === `Bearer ${invalidKey}`)).toBe(true)
			expect({
				auth: readFileSync(join(fixture.agentDir, "auth.json"), "utf-8"),
				models: readFileSync(join(fixture.agentDir, "models.json"), "utf-8"),
			}).toEqual(fixture.seedResult)
			trace.step("invalid environment key reported; saved account was not used or overwritten")
		},
	)
})
