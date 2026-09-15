import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a rejected saved Kimchi key stays synchronized while another provider can chat", async ({ terminal }) => {
	const rejectedKey = "rejected-saved-key"
	await runKimchiSession(
		terminal,
		{
			artifactName: "saved-api-key-rejected",
			rejectedApiKeys: [rejectedKey],
			models: [{ slug: "basic", displayName: "Test Model" }],
			responses: [{ stream: ["Other provider still works."] }],
			env: { KIMCHI_API_KEY: "" },
			seedHome(homeDir) {
				const configPath = join(homeDir, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf-8"))
				writeFileSync(configPath, JSON.stringify({ ...config, apiKey: rejectedKey }))
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const modelsPath = join(agentDir, "models.json")
				const models = JSON.parse(readFileSync(modelsPath, "utf-8"))
				models.providers["kimchi-dev"] = { ...models.providers.fake, apiKey: "$KIMCHI_API_KEY" }
				writeFileSync(modelsPath, JSON.stringify(models))
				writeFileSync(
					join(agentDir, "auth.json"),
					JSON.stringify({
						"kimchi-dev": { type: "api_key", key: "previous-kimchi-key" },
						fake: { type: "api_key", key: "fake" },
					}),
				)
			},
		},
		async (fixture, trace) => {
			const auth = JSON.parse(readFileSync(join(fixture.agentDir, "auth.json"), "utf-8"))
			expect(auth["kimchi-dev"]).toEqual({ type: "api_key", key: rejectedKey })
			expect(auth.fake).toEqual({ type: "api_key", key: "fake" })
			expect(
				fixture.fake.requests.some(
					(request) => request.url.includes("/metadata") && request.headers.authorization === `Bearer ${rejectedKey}`,
				),
			).toBe(true)
			trace.step("startup synchronized the rejected saved key and preserved the other provider")
			terminal.submit("Say hello")
			await waitForText(terminal, "Other provider still works.")
			trace.step("another provider completed a chat turn after Kimchi rejected the saved key")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/model kimchi-dev/basic")
			await waitForText(terminal, "Model: basic")
			terminal.submit("Try the Kimchi model")
			await waitForText(terminal, "Invalid API key")
			expect(
				fixture.fake.requests.some(
					(request) =>
						request.url.includes("/chat/completions") && request.headers.authorization === `Bearer ${rejectedKey}`,
				),
			).toBe(true)
			trace.step("the Kimchi request used the saved key and the API rejected it without an extension guard")
		},
	)
})
