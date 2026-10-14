import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import type { FakeOpenAiServer } from "./support/fake-openai-server.js"
import { BINARY_PATH, createKimchiFixture, runKimchiSession, sh, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Point the harness's OTLP sends at the fake server; returns the config path for later assertions. */
function seedTelemetryEndpoints(home: string, fakeBaseUrl: string): string {
	const configPath = join(home, ".config", "kimchi", "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
	config.telemetry = { endpoint: `${fakeBaseUrl}/logs`, metricsEndpoint: `${fakeBaseUrl}/metrics` }
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`)
	return configPath
}

const telemetryRequests = (fake: FakeOpenAiServer) =>
	fake.requests.filter((r) => r.url.startsWith("/logs") || r.url.startsWith("/metrics"))

test("an org FORCE_OFF policy suppresses all telemetry, even for an opted-in user", async ({ terminal }) => {
	let configPath = ""
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-telemetry-force-off",
			responses: [],
			policy: { modes: undefined, usageReporting: "FORCE_OFF" },
			seedHome(home, _cwd, fakeBaseUrl) {
				configPath = seedTelemetryEndpoints(home, fakeBaseUrl)
			},
		},
		async (fixture, trace) => {
			// app_started / harness_launched would fire during startup: give them a window to arrive.
			await sleep(2_500)
			expect(telemetryRequests(fixture.fake)).toHaveLength(0)
			// FORCE_OFF never mints a device ID.
			const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
			expect(config.deviceId).toBeUndefined()
			trace.step("no OTLP request reached the ingest endpoint and no device ID was written")
		},
	)
})

// The `config telemetry` UX under a policy (status line, persist-and-warn)
// is driven as plain shell commands in the harness terminal: the fixture fake
// server already serves the policy endpoints (KIMCHI_REMOTE_ENDPOINT points at
// it), and no TUI repaint clears the output.
test("an org FORCE_ON policy surfaces through `kimchi config telemetry`", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [],
		policy: { modes: undefined, usageReporting: "FORCE_ON" },
	})
	try {
		const env = `env HOME=${sh(fixture.homeDir)} KIMCHI_REMOTE_ENDPOINT=${sh(fixture.fake.baseUrl)} KIMCHI_TELEMETRY_ENABLED=0`
		terminal.submit(`${env} ${sh(BINARY_PATH)} config telemetry`)
		await waitForText(
			terminal,
			"[policy] usage reporting is enforced on by your organization; effective telemetry is enabled this session.",
		)
		await waitForText(
			terminal,
			"Telemetry: enabled (enforced on by your organization's policy; from KIMCHI_TELEMETRY_ENABLED=0, overrides config)",
		)

		terminal.submit(`${env} ${sh(BINARY_PATH)} config telemetry off`)
		await waitForText(terminal, "Telemetry disabled")
		await waitForText(terminal, "Note: your organization's policy enforces telemetry on; effective state unchanged.")

		// The user's persisted preference survives the policy: a later
		// USER_CHOICE transition restores it.
		const config = JSON.parse(readFileSync(join(fixture.homeDir, ".config", "kimchi", "config.json"), "utf8")) as {
			telemetry: { enabled: boolean }
		}
		expect(config.telemetry.enabled).toBe(false)
	} finally {
		await fixture.stop()
	}
})

test("an org FORCE_OFF policy surfaces through `kimchi config telemetry`", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [],
		policy: { modes: undefined, usageReporting: "FORCE_OFF" },
	})
	try {
		const env = `env HOME=${sh(fixture.homeDir)} KIMCHI_REMOTE_ENDPOINT=${sh(fixture.fake.baseUrl)}`
		terminal.submit(`${env} ${sh(BINARY_PATH)} config telemetry`)
		await waitForText(
			terminal,
			"[policy] usage reporting is enforced off by your organization; effective telemetry is disabled this session.",
		)
		await waitForText(terminal, "Telemetry: disabled (enforced off by your organization's policy)")

		terminal.submit(`${env} ${sh(BINARY_PATH)} config telemetry on`)
		await waitForText(terminal, "Telemetry enabled")
		await waitForText(terminal, "Note: your organization's policy enforces telemetry off; effective state unchanged.")

		// An aligned write stays silent — no additional warning line beyond the
		// one the earlier opted-in `on` write produced.
		terminal.submit(`${env} ${sh(BINARY_PATH)} config telemetry off`)
		await waitForText(terminal, "Telemetry disabled")
		const notes = fullText(terminal).match(/Note: your organization's policy enforces telemetry off/g) ?? []
		expect(notes).toHaveLength(1)
	} finally {
		await fixture.stop()
	}
})

test("an org FORCE_ON policy sends telemetry despite the env opt-out", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-telemetry-force-on",
			responses: [],
			policy: { modes: undefined, usageReporting: "FORCE_ON" },
			seedHome(home, _cwd, fakeBaseUrl) {
				seedTelemetryEndpoints(home, fakeBaseUrl)
				return { env: { KIMCHI_TELEMETRY_ENABLED: "0" } }
			},
		},
		async (fixture, trace) => {
			const deadline = Date.now() + 15_000
			while (Date.now() < deadline) {
				if (telemetryRequests(fixture.fake).some((r) => JSON.stringify(r.body).includes("app_started"))) {
					trace.step("app_started reached the ingest endpoint while KIMCHI_TELEMETRY_ENABLED=0")
					return
				}
				await sleep(200)
			}
			throw new Error("FORCE_ON: no app_started event reached the ingest endpoint")
		},
	)
})
