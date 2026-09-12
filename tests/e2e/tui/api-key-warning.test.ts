import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("shows the environment override warning in the ready editor and uses that key for chat", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "api-key-warning",
			providerId: "kimchi-dev/openai",
			models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
			initialModel: "ci-model",
			rejectedApiKeys: ["fake", "stale-key"],
			responses: [{ stream: ["Environment authentication works."] }],
			seedHome(homeDir) {
				writeFileSync(
					join(homeDir, ".config", "kimchi", "harness", "auth.json"),
					JSON.stringify({ "kimchi-dev/openai": { type: "api_key", key: "stale-key" } }),
				)
				return { env: { KIMCHI_API_KEY: "ci-key" } }
			},
		},
		async (fixture, trace) => {
			await expect(terminal.getByText("KIMCHI_API_KEY differs from your saved key.")).toBeVisible()
			trace.step("warning remains visible after startup screen clear")
			terminal.submit("Say hello")
			await waitForText(terminal, "Environment authentication works.")
			for (const path of ["/v1/models/metadata", "chat/completions"]) {
				const request = fixture.fake.requests.find((request) => request.url.includes(path))
				expect(request?.headers.authorization).toBe("Bearer ci-key")
			}
			const config = JSON.parse(readFileSync(join(fixture.homeDir, ".config", "kimchi", "config.json"), "utf-8"))
			expect(config.apiKey).toBe("fake")
			trace.step("metadata and chat used environment key while saved login was preserved")
		},
	)
})
