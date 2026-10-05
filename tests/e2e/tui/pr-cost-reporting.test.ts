import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const telemetry of [false, true]) {
	test(`PR reporting follows SaaS uploads (${telemetry ? "on" : "off"}) until explicitly changed`, async ({
		terminal,
	}) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `pr-cost-reporting-${telemetry}`,
				responses: [],
				gitInit: true,
				env: { KIMCHI_TELEMETRY_ENABLED: String(telemetry) },
				seedHome(homeDir) {
					const path = join(homeDir, ".config/kimchi/config.json")
					const config = JSON.parse(readFileSync(path, "utf8"))
					config.telemetry = {
						endpoint: `${config.llmEndpoint}/logs`,
						metricsEndpoint: `${config.llmEndpoint}/metrics`,
					}
					writeFileSync(path, JSON.stringify(config))
				},
			},
			async (fixture, trace) => {
				const path = join(fixture.agentDir, "pr-cost-reporting", "state.json")
				terminal.submit("/pr-reporting status")
				await waitForText(terminal, `PR reporting: ${telemetry ? "on" : "off"}`)
				if (!telemetry) expect(existsSync(path)).toBe(false)
				trace.step("reporting follows the existing SaaS upload setting")
				terminal.submit("/pr-reporting on")
				await waitForText(terminal, "PR reporting on.")
				expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(true)
				trace.step("explicit consent is saved and the upload fields are explained")
				terminal.submit("/pr-reporting off")
				await waitForText(terminal, "Pending uploads were deleted")
				const state = JSON.parse(readFileSync(path, "utf8"))
				expect(state.enabled).toBe(false)
				expect(state.entries).toEqual({})
				expect(fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(0)
				trace.step("reporting is off again with no model calls")
			},
		)
	})
}
