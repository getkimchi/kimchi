// ACP integration: with legacy Ferment off (the default), /ferment-legacy is
// still in the palette, and running it shows how to turn legacy on. Before
// the stub existed, the text went to the model as a normal prompt.

import { afterEach, describe, expect, it } from "vitest"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, waitFor } from "./support/scenarios.js"

describe("ACP integration — /ferment-legacy when legacy Ferment is off", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("advertises the command, shows the enable hint, and sends no prompt to the model", async () => {
		fixture = await startAcpFixture({ artifactName: "acp-ferment-legacy-stub", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const names = await waitFor(
			() => commandNames(active, sessionId),
			(found) => found.includes("bug"),
		)
		expect(names).toContain("ferment-legacy")

		const result = await prompt(active, sessionId, "/ferment-legacy list")
		expect(result.stopReason).toBe("end_turn")

		const warnings = await waitFor(
			() =>
				active.client.extNotifications
					.filter((n) => n.method === "_kimchi.dev/pi_notify")
					.map((n) => JSON.stringify(n.params))
					.filter((params) => params.includes("/ferment-legacy needs the legacy Ferment")),
			(found) => found.length > 0,
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("kimchi resources enable extensions.ferment-legacy")
		expect(warnings[0]).toContain("Then restart kimchi to load it.")
		expect(warnings[0]).toContain('"notifyType":"warning"')
		expect(chatRequests(active)).toHaveLength(0)
	})
})
