// ACP integration: with legacy Ferment off (the default), /ferment-legacy is
// not in the palette. The stub warns through pi_notify, which plain clients
// do not show, so listing it would add an entry that seems to do nothing. A
// client that sends the command anyway still gets the stub: the enable hint
// goes out as pi_notify, and nothing reaches the model. With legacy on at
// startup, V1 loads and the palette lists the command.

import { afterEach, describe, expect, it } from "vitest"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, waitFor } from "./support/scenarios.js"

describe("ACP integration — /ferment-legacy palette and stub", () => {
	let fixture: AcpFixture | undefined
	let previousEnableResources: string | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
		if (previousEnableResources === undefined) Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		else process.env.KIMCHI_ENABLE_RESOURCES = previousEnableResources
	})

	it("hides the command when legacy is off, and the stub still answers with the enable hint", async () => {
		previousEnableResources = process.env.KIMCHI_ENABLE_RESOURCES
		Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		fixture = await startAcpFixture({ artifactName: "acp-ferment-legacy-stub", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const names = await waitFor(
			() => commandNames(active, sessionId),
			(found) => found.includes("bug"),
		)
		expect(names).not.toContain("ferment-legacy")

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

	it("lists the command when legacy is on at startup", async () => {
		previousEnableResources = process.env.KIMCHI_ENABLE_RESOURCES
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-legacy"
		fixture = await startAcpFixture({ artifactName: "acp-ferment-legacy-loaded", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const names = await waitFor(
			() => commandNames(active, sessionId),
			(found) => found.includes("bug"),
		)
		expect(names.filter((name) => name === "ferment-legacy")).toHaveLength(1)
	})
})
