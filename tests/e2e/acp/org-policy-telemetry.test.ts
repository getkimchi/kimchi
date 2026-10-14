import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { afterEach, expect, it } from "vitest"

import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"

/**
 * Org usage-reporting policy enforcement fires in the shared CLI bootstrap,
 * so ACP is covered by the same choke point as the TUI: these are thin
 * parity guards asserting zero (FORCE_OFF) or some (FORCE_ON) OTLP traffic.
 */

let fixture: AcpFixture | undefined
afterEach(async () => {
	await fixture?.stop()
	fixture = undefined
})

const telemetryRequests = (f: AcpFixture) =>
	f.fake.requests.filter((r) => r.url.startsWith("/logs") || r.url.startsWith("/metrics"))

it("FORCE_OFF suppresses all telemetry even when the user is opted in", async () => {
	fixture = await startAcpFixture({
		artifactName: "org-policy-telemetry-force-off",
		telemetry: true,
		policy: { modes: undefined, usageReporting: "FORCE_OFF" },
		responses: [],
	})

	// app_started would fire during startup; give it a window to arrive.
	await sleep(2_500)
	expect(telemetryRequests(fixture)).toHaveLength(0)

	// FORCE_OFF never mints a device ID.
	const config = JSON.parse(readFileSync(join(fixture.homeDir, ".config", "kimchi", "config.json"), "utf8")) as Record<
		string,
		unknown
	>
	expect(config.deviceId).toBeUndefined()
})

it("FORCE_ON sends telemetry despite the env opt-out", async () => {
	fixture = await startAcpFixture({
		artifactName: "org-policy-telemetry-force-on",
		telemetry: false, // KIMCHI_TELEMETRY_ENABLED=false
		policy: { modes: undefined, usageReporting: "FORCE_ON" },
		responses: [],
	})

	await expect
		.poll(
			() =>
				telemetryRequests(fixture as AcpFixture).filter((r) => JSON.stringify(r.body).includes("app_started")).length,
			{ timeout: 15_000 },
		)
		.toBeGreaterThan(0)
})
