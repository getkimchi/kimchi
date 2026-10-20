import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
afterEach(async () => {
	await fixture?.stop()
	vi.unstubAllEnvs()
})

// What Kimchi treats as CI or a benchmark; the runner's own would mark this session as not reported.
const AUTOMATION_VARIABLES = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"BUILDKITE",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
	"CIRCLECI",
	"TF_BUILD",
	"KIMCHI_PR_COST_REPORTING",
	"KIMCHI_INFRA_BREAKER_THRESHOLD",
]

it.each([
	false,
	true,
])("lets the gateway report PR costs per the SaaS setting (%s) until /pr-reporting changes it", async (telemetry) => {
	for (const name of AUTOMATION_VARIABLES) vi.stubEnv(name, "")
	// Two scripted answers, two turns: no continuation round in between.
	vi.stubEnv("KIMCHI_DISABLE_NUDGE_CONTINUATION", "1")
	const active = await startAcpFixture({
		artifactName: "pr-cost-reporting",
		telemetry,
		responses: [{ stream: ["First answer."] }, { stream: ["Second answer."] }],
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})
	fixture = active
	const sessionId = await newSession(active, active.workDir)
	const path = join(active.homeDir, ".config/kimchi/harness/pr-cost-reporting/state.json")
	const notified = (message: string, after: number) =>
		expect
			.poll(() => active.client.extNotifications.slice(after))
			.toContainEqual({
				method: "_kimchi.dev/pi_notify",
				params: expect.objectContaining({ sessionId, message: expect.stringContaining(message) }),
			})
	const command = async (text: string, message: string) => {
		const after = active.client.extNotifications.length
		expect((await prompt(active, sessionId, text)).stopReason).toBe("end_turn")
		await notified(message, after)
	}
	const chat = () => active.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))

	await command("/pr-reporting status", `PR reporting   ${telemetry ? "Enabled" : "Disabled"} (SaaS default)`)
	if (!telemetry) expect(existsSync(path)).toBe(false)

	const beforeTurn = active.client.extNotifications.length
	expect((await prompt(active, sessionId, "Answer once.")).stopReason).toBe("end_turn")
	expect(chat()[0].headers["x-kimchi-pr-reporting"]).toBe(telemetry ? "proxy" : "off")
	// Studio learns once, after its first turn, that the gateway reports PR costs by default.
	if (telemetry) await notified("PR costs are reported to your account by the Kimchi gateway", beforeTurn)

	await command(`/pr-reporting ${telemetry ? "off" : "on"}`, `PR reporting ${telemetry ? "off" : "on"}.`)
	expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(!telemetry)

	expect((await prompt(active, sessionId, "Answer again.")).stopReason).toBe("end_turn")
	const second = chat()[1]
	expect(second.headers["x-kimchi-pr-reporting"]).toBe(telemetry ? "off" : "proxy")
	if (!telemetry) {
		// The gateway groups reported requests by session and turn even with telemetry off.
		expect(second.headers["x-session-id"]).toBeTruthy()
		expect(second.headers["x-turn-index"]).toBe("2")
	}
})
