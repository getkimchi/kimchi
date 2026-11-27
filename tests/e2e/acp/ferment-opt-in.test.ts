// ACP integration: Ferment loads only for a client that opts in with
// `_meta["kimchi.dev"].ferment`. Legacy Ferment (V1) never loads over ACP.
//
// A client that opts into nothing sees no /ferment in the palette, gets no
// Ferment tools, and a typed /ferment goes to the model as an ordinary prompt,
// the same as other opt-in commands such as /pr-watch.

import { afterEach, describe, expect, it } from "vitest"
import { UPDATE_FERMENT_V2_TOOL_NAME } from "../../../src/extensions/ferment-v2/constants.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, waitFor } from "./support/scenarios.js"

const FERMENT_META = { "kimchi.dev": { ferment: true } } as const

function paletteOf(fixture: AcpFixture, sessionId: string): Promise<string[]> {
	return waitFor(
		() => commandNames(fixture, sessionId),
		(found) => found.includes("bug"),
	)
}

describe("ACP integration — Ferment opt-in", () => {
	let fixture: AcpFixture | undefined
	let previousEnableResources: string | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
		if (previousEnableResources === undefined) Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
		else process.env.KIMCHI_ENABLE_RESOURCES = previousEnableResources
		previousEnableResources = undefined
	})

	it("advertises the ferment capability so clients can detect the gate", async () => {
		fixture = await startAcpFixture({ artifactName: "acp-ferment-opt-in-advertised", responses: [] })
		expect(fixture.initializeResponse.agentCapabilities?._meta?.["kimchi.dev"]).toMatchObject({ ferment: true })
	})

	it("without the opt-in: no /ferment, no Ferment tools, and /ferment reaches the model as text", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-ferment-opt-in-off",
			responses: [{ stream: ["Plain reply."] }],
		})
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		expect(await paletteOf(active, sessionId)).not.toContain("ferment")

		const result = await prompt(active, sessionId, "/ferment refactor auth")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Plain reply.")

		const requests = chatRequests(active)
		expect(requests).toHaveLength(1)
		const body = JSON.stringify(requests[0]?.body)
		expect(body).toContain("/ferment refactor auth")
		expect(body).not.toContain(UPDATE_FERMENT_V2_TOOL_NAME)
	})

	it("with the opt-in: /ferment is listed once and its tools reach the model", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-ferment-opt-in-on",
			responses: [{ stream: ["Acknowledged."] }],
			clientMeta: FERMENT_META,
		})
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const names = await paletteOf(active, sessionId)
		expect(names.filter((name) => name === "ferment")).toHaveLength(1)

		await prompt(active, sessionId, "Hello.")
		expect(JSON.stringify(chatRequests(active)[0]?.body)).toContain(UPDATE_FERMENT_V2_TOOL_NAME)
	})

	// Legacy Ferment is not supported over ACP: no palette entry and no stub,
	// even with legacy on at startup and the Ferment opt-in set.
	it("never loads legacy Ferment, even with legacy on and the opt-in set", async () => {
		previousEnableResources = process.env.KIMCHI_ENABLE_RESOURCES
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.ferment-legacy"
		fixture = await startAcpFixture({
			artifactName: "acp-ferment-opt-in-legacy",
			responses: [{ stream: ["Plain reply."] }],
			clientMeta: FERMENT_META,
		})
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		expect(await paletteOf(active, sessionId)).not.toContain("ferment-legacy")

		const result = await prompt(active, sessionId, "/ferment-legacy list")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Plain reply.")
		expect(chatRequests(active)).toHaveLength(1)
		// No "needs the legacy Ferment" hint: the stub is not loaded either.
		const notifies = active.client.extNotifications.map((n) => JSON.stringify(n.params))
		expect(notifies.some((params) => params.includes("legacy Ferment"))).toBe(false)
	})
})
