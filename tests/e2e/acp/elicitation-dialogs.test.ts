// ACP integration: drives ctx.ui.confirm / ctx.ui.select / ctx.ui.input from
// an extension and verifies the resulting elicitation/create wire shape.
//
// Why this exists: the permission flow always goes through requestPermission
// (see src/modes/acp/acp-prompter.ts), so the other capability tests can't
// exercise the elicitation path implicitly. This test fills that gap by
// loading an extension that explicitly invokes the three dialog methods.

import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const DIALOG_EXTENSION_PATH = fileURLToPath(new URL("./support/test-dialog-extension.js", import.meta.url))

const ELICITATION_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

describe("ACP integration — elicitation dialogs", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "elicitation-dialogs",
			// The fake LLM isn't actually exercised — the extension drives
			// the dialog calls on session_start, before any user prompt.
			responses: [{ stream: ["placeholder"] }],
			clientCapabilities: ELICITATION_CAPABILITIES,
			extensionPath: DIALOG_EXTENSION_PATH,
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("routes confirm/select/input through elicitation/create with the expected wire shape", async () => {
		// newSession triggers session_start, which fires the extension's
		// three ctx.ui.* calls in order. Wait until all three reach the
		// recording client (the extension awaits each dialog in turn, so
		// they arrive sequentially but the extension's handler resolves
		// asynchronously after newSession returns).
		await newSession(fixture, fixture.workDir)
		await waitForElicitationCount(fixture, 3)

		const [confirmReq, selectReq, inputReq] = fixture.client.elicitationRequests
		const sessionId = fixture.client.sessionUpdates[0]?.sessionId ?? ""

		// confirm("Proceed?", "This dialog exercises elicitation wire shape.")
		// → wire message is "<title>: <message>".
		expect(confirmReq).toEqual({
			method: "elicitation/create",
			params: {
				sessionId,
				mode: "form",
				message: "Proceed?: This dialog exercises elicitation wire shape.",
				requestedSchema: {
					type: "object",
					properties: {
						// No title/description on properties — those belong to
						// top-level metadata, not to form fields.
						confirmed: {
							type: "boolean",
							default: false,
						},
					},
					required: ["confirmed"],
				},
			},
		})

		// select("Pick a colour", ["red", "green", "blue"])
		// → wire message is just the title (select has no body).
		expect(selectReq).toEqual({
			method: "elicitation/create",
			params: {
				sessionId,
				mode: "form",
				message: "Pick a colour",
				requestedSchema: {
					type: "object",
					properties: {
						value: {
							type: "string",
							oneOf: [
								{ const: "red", title: "red" },
								{ const: "green", title: "green" },
								{ const: "blue", title: "blue" },
							],
						},
					},
					required: ["value"],
				},
			},
		})

		// input("Workspace name", "e.g. my-project")
		// → wire message is just the title; description carries the placeholder.
		expect(inputReq).toEqual({
			method: "elicitation/create",
			params: {
				sessionId,
				mode: "form",
				message: "Workspace name",
				requestedSchema: {
					type: "object",
					properties: {
						// No title on the property; description is the placeholder.
						value: {
							type: "string",
							description: "e.g. my-project",
						},
					},
					required: ["value"],
				},
			},
		})
	})
})

async function waitForElicitationCount(
	fixture: AcpFixture,
	count: number,
	timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<void> {
	const start = Date.now()
	while (fixture.client.elicitationRequests.length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`expected ${count} elicitation/create calls within ${timeoutMs}ms; saw ${fixture.client.elicitationRequests.length}`,
			)
		}
		await delay(50)
	}
}
