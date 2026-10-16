import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

// The variables `automation.ts` treats as CI; the runner's own would mark this session as not reported.
const CI_VARIABLES = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"BUILDKITE",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
	"CIRCLECI",
	"TF_BUILD",
]

for (const telemetry of [false, true]) {
	test(`the gateway reports PR costs per the SaaS setting (${telemetry ? "on" : "off"}) until explicitly changed`, async ({
		terminal,
	}) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `pr-cost-reporting-${telemetry}`,
				responses: [{ stream: ["First answer."] }, { stream: ["Second answer."] }],
				gitInit: true,
				env: {
					KIMCHI_TELEMETRY_ENABLED: String(telemetry),
					KIMCHI_DISABLE_NUDGE_CONTINUATION: "1",
					...Object.fromEntries(CI_VARIABLES.map((name) => [name, ""])),
				},
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
				if (telemetry) {
					await waitForText(terminal, "PR costs are reported to your account by the Kimchi gateway")
					expect(fullText(terminal)).toMatch(/\/pr-reporting\s+off/)
					expect(JSON.parse(readFileSync(path, "utf8")).defaultNoticeShown).toBe(true)
				} else expect(fullText(terminal)).not.toContain("PR costs are reported to your account")
				terminal.submit("/pr-reporting status")
				await waitForText(terminal, `PR reporting   ${telemetry ? "Enabled" : "Disabled"} (SaaS default)`)
				if (!telemetry) expect(existsSync(path)).toBe(false)
				trace.step("reporting follows the SaaS telemetry setting")

				terminal.submit("Answer once.")
				await waitForText(terminal, "First answer.")
				const [first] = chatRequests(fixture)
				expect(first.headers["x-kimchi-pr-reporting"]).toBe(telemetry ? "proxy" : "off")
				if (telemetry) expect(first.headers["x-session-id"]).toBeTruthy()
				trace.step("the model request tells the gateway whether it may report PR costs")

				terminal.submit(`/pr-reporting ${telemetry ? "off" : "on"}`)
				await waitForText(terminal, `PR reporting ${telemetry ? "off" : "on"}.`)
				expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(!telemetry)
				trace.step("the explicit choice is saved")

				terminal.submit("Answer again.")
				await waitForText(terminal, "Second answer.")
				const second = chatRequests(fixture)[1]
				expect(second.headers["x-kimchi-pr-reporting"]).toBe(telemetry ? "off" : "proxy")
				if (!telemetry) {
					// The gateway groups reported requests by session and turn even with telemetry off.
					expect(second.headers["x-session-id"]).toBeTruthy()
					expect(second.headers["x-turn-index"]).toBe("2")
				}
				trace.step("the next request follows the explicit choice")
			},
		)
	})
}
