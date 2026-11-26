// ACP integration: /ferment replies reach plain clients as agent text.
//
// The handler answers through ctx.ui.notify, which ACP sends as pi_notify.
// Plain clients ignore pi_notify, so a reply-only command looked like it did
// nothing. Notifies sent while the handler runs are also sent as an
// agent_message_chunk. Notifies from a turn the command started are not.

import { afterEach, describe, expect, it } from "vitest"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

function agentTextChunks(fixture: AcpFixture, sessionId: string): string[] {
	return fixture.client.sessionUpdates.flatMap(({ sessionId: id, update }) =>
		id === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
			? [update.content.text]
			: [],
	)
}

function notifyMessages(fixture: AcpFixture, sessionId: string): string[] {
	return fixture.client.extNotifications.flatMap(({ method, params }) => {
		if (method !== "_kimchi.dev/pi_notify") return []
		const payload = params as { method?: string; message?: unknown; sessionId?: string }
		return payload.method === "notify" && payload.sessionId === sessionId && typeof payload.message === "string"
			? [payload.message]
			: []
	})
}

describe("ACP integration — /ferment command replies", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it("answers /ferment pause with visible text when no run exists", async () => {
		fixture = await startAcpFixture({ artifactName: "acp-ferment-reply-pause", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const result = await prompt(active, sessionId, "/ferment pause")

		expect(result.stopReason).toBe("end_turn")
		const replies = agentTextChunks(active, sessionId).filter((text) => text.includes("No Ferment is currently set."))
		expect(replies).toEqual(["No Ferment is currently set.\n\n"])
		expect(chatRequests(active)).toHaveLength(0)
	})

	it("answers bare /ferment with the summary", async () => {
		fixture = await startAcpFixture({ artifactName: "acp-ferment-reply-summary", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const result = await prompt(active, sessionId, "/ferment")

		expect(result.stopReason).toBe("end_turn")
		const replies = agentTextChunks(active, sessionId).filter((text) =>
			text.includes("Use /ferment <objective> to create one."),
		)
		expect(replies).toHaveLength(1)
		expect(chatRequests(active)).toHaveLength(0)
	})

	it("answers a legacy word with the hint", async () => {
		fixture = await startAcpFixture({ artifactName: "acp-ferment-reply-legacy-word", responses: [] })
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const result = await prompt(active, sessionId, "/ferment list")

		expect(result.stopReason).toBe("end_turn")
		const replies = agentTextChunks(active, sessionId).filter((text) => text.includes("Use /ferment-legacy list."))
		expect(replies).toHaveLength(1)
		expect(chatRequests(active)).toHaveLength(0)
	})

	it("answers /ferment with the enable hint as text when Ferment is off", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-ferment-reply-off",
			responses: [],
			settings: { resources: { "extensions.ferment": false } },
		})
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const result = await prompt(active, sessionId, "/ferment refactor auth")

		expect(result.stopReason).toBe("end_turn")
		const replies = agentTextChunks(active, sessionId).filter((text) =>
			text.includes("kimchi resources enable extensions.ferment"),
		)
		expect(replies).toHaveLength(1)
		expect(chatRequests(active)).toHaveLength(0)
	})

	it("does not mirror notifications from the run itself", async () => {
		const modelText = "FERMENT_RUN_MODEL_TEXT"
		fixture = await startAcpFixture({
			artifactName: "acp-ferment-reply-run-scope",
			responses: [{ stream: [modelText] }],
		})
		const active = fixture
		const sessionId = await newSession(active, active.workDir)

		const result = await prompt(active, sessionId, "/ferment build the reply scope check")
		expect(result.stopReason).not.toBe("ERROR")

		await waitFor(
			() => agentTextChunks(active, sessionId).join(""),
			(text) => text.includes(modelText),
		)
		// The fake model never calls a Ferment tool, so the run pauses itself
		// after its stalled continuation turns. That notify comes from the run
		// after the handler returned, so it must not become agent text.
		await waitFor(
			() => notifyMessages(active, sessionId),
			(messages) => messages.some((message) => message.startsWith("Ferment paused")),
		)
		const runNotifies = notifyMessages(active, sessionId).filter((message) => message !== "Ferment created.")

		const chunks = agentTextChunks(active, sessionId)
		expect(chunks.filter((text) => text === "Ferment created.\n\n")).toHaveLength(1)
		for (const message of runNotifies) {
			expect(chunks).not.toContain(`${message}\n\n`)
		}
	})
})
